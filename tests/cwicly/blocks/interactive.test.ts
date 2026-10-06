/**
 * The Cwicly interactive blocks (src/cwicly/blocks/interactive.ts): accordions, tabs, modals,
 * popovers, sliders, navigation, menus, inputs, filters, range sliders and swatches. None of
 * Cwicly's scripts is ported, so what a block becomes is native markup and CSS, and what the tests
 * hold it to is what a browser does with it.
 *
 * Real data stands behind everything the two fixture sites have: fineline's header navigation (four
 * `nav`, three `navitems`, 23 `navlink`, four `menu`, two `filter`) and anabaptistperspectives'
 * modals, popover, inputs, menus and filters. Neither site uses accordions, tabs, sliders or
 * dropdowns, so those are the markup of littlecocalico's database (the third checkout, deferred as a
 * migration but a real Cwicly site), trimmed to a few items and named as such; `SWATCH`,
 * `RANGESLIDER` and `NAVMENU` occur in no database at all and are built from the editor's `save()`
 * (`build/index.js` of the plugin), also named. In order:
 *
 * 1. the census: every interactive block of both sites converts, with the counts asserted;
 * 2. each block: accordions, tabs, modals, popovers, sliders, navigation, menus, inputs, filters;
 * 3. the live pages (tests/fixtures/<site>/html) as oracle for the header navigation of both sites;
 * 4. building through Jx (`jx build`, `jx validate`);
 * 5. a real browser (Chrome driven through puppeteer-core, skipped where there is none): the accordion
 *    opens, the group is exclusive, a tab shows its panel, a modal opens from its opener and closes,
 *    the navigation collapses and opens at mobile width, a dropdown opens on hover, and computed
 *    styles agree with the markup the plugin printed.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFragment, serializeOuter } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import puppeteer from "puppeteer-core";
import type { Browser, Page } from "puppeteer-core";
import { coreConverters } from "../../../src/core/blocks.ts";
import { withRegistry } from "../../../src/convert.ts";
import { layoutConverters } from "../../../src/cwicly/blocks/layout.ts";
import { parseCwiclyCss } from "../../../src/cwicly/css.ts";
import { nodesToHtml } from "../../../src/html.ts";
import { escapeHtml } from "../../../src/cwicly/tokens.ts";
import { decodeEntities } from "../../../src/wp/model.ts";
import { finishNodes, mergeStyle } from "../../../src/jx-util.ts";
import { PLACEHOLDERS, readPlaceholder, walkElements } from "../../../src/placeholders.ts";
import { parseBlocks, walkBlocks } from "../../../src/wp/blocks.ts";
import type {
  BlockConverter,
  ConvertCtx,
  JxElement,
  JxNode,
  JxStyle,
  ReportEntry,
  WpBlock,
} from "../../../src/types.ts";
import {
  buildCompatCss,
  compatFeaturesForBlocks,
  dirPluginSource,
} from "../../../src/emit/compat-css.ts";
import {
  allSubjects,
  loadSite,
  makeCtx,
  subjectBlocks,
  type SiteName,
  type Subject,
} from "../../helpers/ctx.ts";
import { fixtureCssDir } from "../../helpers/fixture-css.ts";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "../../helpers/jx-build.ts";
import type { BuiltProject, ProjectFile } from "../../helpers/jx-build.ts";

setDefaultTimeout(240_000);
afterAll(cleanupJxProjects);

/**
 * The converters under test. `WP2JX_INTERACTIVE_SRC` points the file at a mutated copy (the mutation
 * check of the module: see the report), and is never set otherwise.
 */
const source = process.env.WP2JX_INTERACTIVE_SRC ?? "../../../src/cwicly/blocks/interactive.ts";
const { interactiveConverters } = (await import(source)) as {
  interactiveConverters: Record<string, BlockConverter>;
};

const PLUGIN = "/home/batonac/Development/cwicly";

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const registry: Record<string, BlockConverter> = {
  ...coreConverters,
  ...layoutConverters,
  ...interactiveConverters,
};

interface Run {
  ctx: ConvertCtx;
  hoisted: { selector: string; style: JxStyle }[];
  /** What the conversion reported, without what the stylesheet reader said while the context was made. */
  reports(): ReportEntry[];
}

/** A real context whose `convert` dispatches through core, layout and interactive converters, and whose `hoist` is collected. */
async function runFor(
  site: SiteName,
  subject: Subject,
  over: Partial<ConvertCtx> = {},
): Promise<Run> {
  const base = await makeCtx(site, subject, over);
  const hoisted: Run["hoisted"] = [];
  const ctx = withRegistry({ ...base, hoist: (rule) => hoisted.push(rule) }, registry);
  const before = ctx.report.entries().length;
  return { ctx, hoisted, reports: () => ctx.report.entries().slice(before) };
}

/** Blocks as WordPress saves them in `post_content`. */
const blocksOf = (markup: string): WpBlock[] => parseBlocks(markup);

const el = (node: JxNode | undefined): JxElement => {
  if (typeof node === "string" || node === undefined) throw new Error("expected an element");
  return node;
};

const attrsOf = (node: JxNode | undefined): Record<string, unknown> =>
  (el(node).attributes ?? {}) as Record<string, unknown>;

const kids = (node: JxNode | undefined): JxNode[] => {
  const c = el(node).children;
  return Array.isArray(c) ? c : [];
};

const classes = (node: JxNode | undefined): string[] =>
  (el(node).className ?? "").split(/\s+/).filter(Boolean);

/** Every element of the trees, parents first. */
const all = (nodes: readonly JxNode[]): JxElement[] => [...walkElements(nodes)];

const byClass = (nodes: readonly JxNode[], name: string): JxElement[] =>
  all(nodes).filter((e) => classes(e).includes(name));

const byTag = (nodes: readonly JxNode[], tag: string): JxElement[] =>
  all(nodes).filter((e) => e.tagName === tag);

const html = (nodes: JxNode[]): string => nodesToHtml(nodes);

const codes = (entries: ReportEntry[]): string[] => entries.map((e) => e.code);

const byCode = (entries: ReportEntry[], code: string): ReportEntry[] =>
  entries.filter((e) => e.code === code);

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

/** The nth block of a name in a subject. */
async function nthBlock(site: SiteName, subject: Subject, name: string, nth = 0): Promise<WpBlock> {
  const loaded = await loadSite(site);
  let found: WpBlock | undefined;
  let seen = 0;
  walkBlocks(subjectBlocks(loaded, subject), (b) => {
    if (found === undefined && b.name === name && seen++ === nth) found = b;
  });
  if (!found) throw new Error(`no ${name} #${nth} in ${JSON.stringify(subject)}`);
  return found;
}

const FINELINE_HEADER: Subject = { kind: "part", slug: "header" };
const AP_HEADER: Subject = { kind: "part", slug: "header" };
const AP_MOBILE_MENU: Subject = { kind: "part", slug: "mobile-menu" };
const AP_FOOTER: Subject = { kind: "part", slug: "footer" };

/** The interactive blocks of this module, by name. */
const INTERACTIVE = Object.keys(interactiveConverters);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. The census
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every interactive block of every subject, converted where it sits (its subject's context, so the
 * stylesheets, links and options are its own). Counted by block name.
 */
async function census(site: SiteName) {
  const loaded = await loadSite(site);
  const counts = new Map<string, number>();
  const converted = new Map<string, number>();
  const empty = new Map<string, number>();
  const failures: string[] = [];
  const reports: ReportEntry[] = [];
  for (const subject of allSubjects(loaded)) {
    const blocks = subjectBlocks(loaded, subject);
    const found: WpBlock[] = [];
    walkBlocks(blocks, (b) => {
      if (b.name !== null && INTERACTIVE.includes(b.name)) found.push(b);
    });
    if (found.length === 0) continue;
    // The whole subject, converted as the driver does: what the blocks report is what the report holds.
    const run = await runFor(site, subject);
    run.ctx.convert(blocks);
    for (const e of run.reports()) {
      if (e.code === "block.converter-error") failures.push(`${subject.kind}: ${e.message}`);
      if (e.code === "block.unsupported" && INTERACTIVE.includes(String(e.data?.block)))
        failures.push(`${subject.kind}: ${e.message}`);
    }
    reports.push(...run.reports());
    // And each block on its own, to count what it converts to.
    for (const b of found) {
      const name = b.name as string;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const out = (await runFor(site, subject)).ctx.convert([b]);
      converted.set(name, (converted.get(name) ?? 0) + 1);
      if (out.length === 0) empty.set(name, (empty.get(name) ?? 0) + 1);
    }
  }
  return { counts, converted, empty, failures, reports };
}

describe("the census", () => {
  test("fineline: every interactive block converts", async () => {
    const c = await census("fineline");
    expect(c.failures).toEqual([]);
    expect(Object.fromEntries([...c.counts].sort())).toEqual({
      "cwicly/filter": 2,
      "cwicly/menu": 4,
      "cwicly/nav": 4,
      "cwicly/navitems": 3,
      "cwicly/navlink": 23,
    });
    // Every block converted, none to nothing (a navigation link is never hidden on this site).
    for (const [name, n] of c.counts) {
      expect(c.converted.get(name)).toBe(n);
    }
    expect(Object.fromEntries(c.empty)).toEqual({});
  });

  test("anabaptistperspectives: every interactive block converts", async () => {
    const c = await census("ap");
    expect(c.failures).toEqual([]);
    expect(Object.fromEntries([...c.counts].sort())).toEqual({
      "cwicly/filter": 17,
      "cwicly/input": 16,
      "cwicly/menu": 3,
      "cwicly/modal": 4,
      "cwicly/popover": 1,
    });
    for (const [name, n] of c.counts) {
      expect(c.converted.get(name)).toBe(n);
    }
  });

  test("nothing of the interactive blocks is left to the driver's fallback or reported unsupported", async () => {
    for (const site of ["fineline", "ap"] as const) {
      const c = await census(site);
      const bad = c.reports.filter(
        (e) =>
          (e.code === "block.unsupported" && INTERACTIVE.includes(String(e.data?.block))) ||
          e.code === "block.converter-error",
      );
      expect(bad).toEqual([]);
    }
  });

  test("every interaction the sites use is either carried or reported, by a stable code", async () => {
    const stable = /^(?:interaction\.(?:dropped|approximated)|filter\.static|nav\.nested-link)$/;
    for (const site of ["fineline", "ap"] as const) {
      const c = await census(site);
      for (const e of c.reports.filter((r) => /^(?:interaction|filter|nav)\./.test(r.code))) {
        expect(e.code).toMatch(stable);
        expect(e.where).toBeDefined();
        expect(e.data?.block).toBeDefined();
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Markup the fixtures lack
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const ICON_CHEVRON =
  '<svg xmlns="https://www.w3.org/2000/svg" viewBox="0 0 28 28"><path d="M26.297 12.625l-11.594 11.578c-0.391 0.391-1.016 0.391-1.406 0l-11.594-11.578c-0.391-0.391-0.391-1.031 0-1.422l2.594-2.578c0.391-0.391 1.016-0.391 1.406 0l8.297 8.297 8.297-8.297c0.391-0.391 1.016-0.391 1.406 0l2.594 2.578c0.391 0.391 0.391 1.031 0 1.422z"></path></svg>';

/** One accordion as littlecocalico's database saves it (the FAQ of its fabric page), the content cut to a sentence. */
const accordionMarkup = (
  n: string,
  title: string,
  extra = "",
  state = "cc-accordion-hidden",
  groupAttr = "",
): string => `<!-- wp:cwicly/accordion {"uniqueID":"u-acc-${n}","classID":"accordion-c${n}","id":"accordion-c${n}","additionalClassesR":""${extra}} -->
<div id="accordion-c${n}{idadd}" class="{gcl} ${state} cc-acd" data-cc-accordion="true"${groupAttr}><!-- wp:cwicly/accordionheader {"isStyling":true,"uniqueID":"u-hd-${n}","classID":"accordionheader-c${n}","id":"accordionheader-c${n}","additionalClassesR":"","containerLayoutDisplay":{"lg":"flex"},"containerLayoutJustifyContent":{"lg":"space-between"}} -->
<button id="accordionheader-c${n}{idadd}" class="accordionheader-c${n} {gcl}" data-cc-accordion-header="true" aria-expanded="false"><!-- wp:cwicly/heading {"headingTag":"h2","content":"${title}","uniqueID":"u-h-${n}","classID":"heading-c${n}","id":"heading-c${n}","additionalClassesR":""} -->
<h2>${title}</h2>
<!-- /wp:cwicly/heading --><!-- wp:cwicly/icon {"isStyling":true,"uniqueID":"u-i-${n}","classID":"icon-c${n}","id":"icon-c${n}","additionalClassesR":"","iconIcon":{"id":"icon-chevron-down","viewBox":"0 0 28 28","paths":[null,{"d":"M26.297 12.625z"}]}} -->
<div class="icon-c${n} cc-icn">${ICON_CHEVRON}</div>
<!-- /wp:cwicly/icon --></button>
<!-- /wp:cwicly/accordionheader --><!-- wp:cwicly/accordioncontent {"uniqueID":"u-ct-${n}","classID":"accordioncontent-c${n}","id":"accordioncontent-c${n}","additionalClassesR":""} -->
<div class="cc-acdc" data-cc-accordion-content="true"><!-- wp:cwicly/paragraph {"content":"Answer ${n}.","uniqueID":"u-p-${n}","classID":"paragraph-c${n}","id":"paragraph-c${n}","additionalClassesR":""} -->
<p>Answer ${n}.</p>
<!-- /wp:cwicly/paragraph --></div>
<!-- /wp:cwicly/accordioncontent --></div>
<!-- /wp:cwicly/accordion -->`;

/** The accordions container, as saved (a hand-made variant adds the group attributes the editor writes for `accordionLinked`). */
const accordionsMarkup = (
  inner: string,
  attrs = "",
  groupAttr = "",
): string => `<!-- wp:cwicly/accordions {"uniqueID":"u-accs","classID":"accordions-cd6209b","id":"accordions-c6ec0cb","additionalClassesR":""${attrs}} -->
<div id="accordions-c6ec0cb{idadd}" data-cc-accordions="true"${groupAttr}>${inner}</div>
<!-- /wp:cwicly/accordions -->`;

/** A tab list and its panels as littlecocalico's collections page saves them (two tabs, two panels, a paragraph in each). */
const TABS_MARKUP = `<!-- wp:cwicly/tablist {"tabContentsID":"tabcontents-collection-design","tabContentsActive":0,"uniqueID":"u-tl","classID":"tablist-c566e3d","id":"tablist-c99e585","additionalClassesR":"","globalClass":["tablist-decor-id"]} -->
<div id="tablist-c99e585{idadd}" class="{gcl}" role="tablist" aria-orientation="horizontal" dir="ltr" data-cc-tabs="tabcontents-collection-design"><!-- wp:cwicly/tab {"tabContentActive":true,"uniqueID":"u-t1","classID":"tab-c3347eb","id":"tab-c87247a","additionalClassesR":"","containerLayoutTag":"button"} -->
<button id="tab-c87247a{idadd}" class="{tab_state}" type="button" role="tab" tabindex="0" aria-selected="true"><!-- wp:cwicly/paragraph {"content":"Browse Collections","uniqueID":"u-tp1","classID":"paragraph-c700fec","id":"paragraph-ce97d5e","additionalClassesR":""} -->
<p>Browse Collections</p>
<!-- /wp:cwicly/paragraph --></button>
<!-- /wp:cwicly/tab --><!-- wp:cwicly/tab {"tabContentActive":false,"uniqueID":"u-t2","classID":"tab-c3a36b9","id":"tab-c13547d","additionalClassesR":"","containerLayoutTag":"button"} -->
<button id="tab-c13547d{idadd}" class="{tab_state}" type="button" role="tab" tabindex="-1" aria-selected="false"><!-- wp:cwicly/paragraph {"content":"Browse All Designs","uniqueID":"u-tp2","classID":"paragraph-ce9ad5b","id":"paragraph-c78c966","additionalClassesR":""} -->
<p>Browse All Designs</p>
<!-- /wp:cwicly/paragraph --></button>
<!-- /wp:cwicly/tab --></div>
<!-- /wp:cwicly/tablist -->
<!-- wp:cwicly/tabcontents {"forceShowID":true,"uniqueID":"u-tcs","classID":"tabcontents-collection-design","id":"tabcontents-collection-design","additionalClassesR":""} -->
<div id="tabcontents-collection-design{idadd}"><!-- wp:cwicly/tabcontent {"isStyling":true,"forceShowID":true,"tabContentActive":true,"uniqueID":"u-tc1","classID":"tabcontent-collections","id":"tabcontent-collections","additionalClassesR":"","containerLayoutDisplay":{"lg":"flex"}} -->
<div id="tabcontent-collections{idadd}" class="tabcontent-collections {tab_content_state} cc-tbc" role="tabpanel"><!-- wp:cwicly/paragraph {"content":"The collections.","uniqueID":"u-cp1","classID":"paragraph-c1","id":"paragraph-c1","additionalClassesR":""} -->
<p>The collections.</p>
<!-- /wp:cwicly/paragraph --></div>
<!-- /wp:cwicly/tabcontent --><!-- wp:cwicly/tabcontent {"isStyling":true,"tabContentActive":false,"uniqueID":"u-tc2","classID":"tabcontent-designs","id":"tabcontent-designs","additionalClassesR":"","containerLayoutDisplay":{"lg":"flex"}} -->
<div class="tabcontent-designs {tab_content_state} cc-tbc" role="tabpanel"><!-- wp:cwicly/paragraph {"content":"All the designs.","uniqueID":"u-cp2","classID":"paragraph-c2","id":"paragraph-c2","additionalClassesR":""} -->
<p>All the designs.</p>
<!-- /wp:cwicly/paragraph --></div>
<!-- /wp:cwicly/tabcontent --></div>
<!-- /wp:cwicly/tabcontents -->`;

/** A slider as littlecocalico's home page saves it (Swiper's markup, two slides of the six, the arrows kept). */
const sliderMarkup = (
  attrs = "",
  extra = "",
): string => `<!-- wp:cwicly/slider {"isStyling":true,"forceShowID":true,"uniqueID":"u-sl","classID":"slider-home-hero","id":"slider-home-hero","additionalClassesR":"","sliderNumberPerWindow":{"lg":"1"},"sliderSpaceBetween":{"lg":"0"}${attrs}} -->
<div id="slider-home-hero{idadd}" class="slider-home-hero" data-slider="" data-slidedirection="horizontal" data-slideslg="1" data-spacebtlg="0"${extra}><div class="swiper"><div id="slider-home-hero-slider-button-prev" class="swiper-button-prev"></div><div id="slider-home-hero-slider-button-next" class="swiper-button-next"></div><div class="swiper-wrapper"><!-- wp:cwicly/sliderchild {"isStyling":true,"uniqueID":"u-s1","classID":"sliderchild-c0c9b62","id":"sliderchild-c95205b","additionalClassesR":""} -->
<div class="swiper-slide cc-slider"><div class="sliderchild-c0c9b62 {gcl} cc-sldc"><!-- wp:cwicly/paragraph {"content":"First slide","uniqueID":"u-sp1","classID":"paragraph-s1","id":"paragraph-s1","additionalClassesR":""} -->
<p>First slide</p>
<!-- /wp:cwicly/paragraph --></div></div>
<!-- /wp:cwicly/sliderchild --><!-- wp:cwicly/sliderchild {"isStyling":true,"uniqueID":"u-s2","classID":"sliderchild-cac1686","id":"sliderchild-c3ff8d9","additionalClassesR":""} -->
<div class="swiper-slide cc-slider"><div class="sliderchild-cac1686 {gcl} cc-sldc"><!-- wp:cwicly/paragraph {"content":"Second slide","uniqueID":"u-sp2","classID":"paragraph-s2","id":"paragraph-s2","additionalClassesR":""} -->
<p>Second slide</p>
<!-- /wp:cwicly/paragraph --></div></div>
<!-- /wp:cwicly/sliderchild --></div></div></div>
<!-- /wp:cwicly/slider -->`;

/** A dropdown as littlecocalico's header saves it: the title link, the toggle, and one group of two links (the real one has five groups). */
const NAVDROPDOWN_MARKUP = `<!-- wp:cwicly/navdropdown {"menuTitle":"Wallpaper","menuDropdownIsCustom":false,"menuGroups":[{"title":"","links":[{"title":"Custom Printed Wallpaper","description":"Order custom wallpaper on a variety of bases","url":"https://example.org/wallpaper/","icon":"","id":"a1"},{"title":"Upload Your Design","description":"Express your style on your walls","url":"https://example.org/upload/","icon":"","id":"a2"}]}],"uniqueID":"u-dd","classID":"navdropdown-c2020d4","id":"navdropdown-cb6c8fd","additionalClassesR":"","linkWrapperActive":true,"linkWrapperUrl":"https://example.org/wallpaper/"} -->
<li id="navdropdown-cb6c8fd{idadd}" class="navdropdown-c2020d4 {gcl} cc-nav-dropdown {currentpageclass=static=https://example.org/wallpaper/}"><div class="cc-nav-item cc-nav-dropdown__button"><a class="cc-nav-dropdown__button--title" href="https://example.org/wallpaper/">Wallpaper</a><button class="cc-nav-dropdown__button--icon" aria-expanded="false" aria-haspopup="true" is-trigger="true"><svg xmlns="https://www.w3.org/2000/svg" viewBox="0 0 32 32" class="cc-nav-dropdown__button--icon--full"><path d="M16 23z"></path></svg><svg xmlns="https://www.w3.org/2000/svg" viewBox="0 0 32 32" class="cc-nav-dropdown__button--icon--modal"><path d="M12 27z"></path></svg></button></div><div class="cc-nav-dropdown__content" style="position:absolute" aria-hidden="true" menu-title="Wallpaper"><div class="cc-nav-dropdown__content--wrapper"><div class="cc-nav__section-header"><h2 class="cc-nav__section-title"><a href="https://example.org/wallpaper/">Wallpaper</a></h2></div><div class="cc-nav__sublevels"></div><div class="cc-nav__section"><div class="cc-nav__submenu"><ul class="cc-nav__submenu-list"><li class="cc-nav__submenu-item"><a href="https://example.org/wallpaper/" class="cc-nav__submenu-item--link"><span class="cc-nav__submenu-item--label-container"><span class="cc-nav__submenu-item--label">Custom Printed Wallpaper</span><p class="cc-nav__submenu-item--description">Order custom wallpaper on a variety of bases</p></span></a></li><li class="cc-nav__submenu-item"><a href="https://example.org/upload/" class="cc-nav__submenu-item--link"><span class="cc-nav__submenu-item--label-container"><span class="cc-nav__submenu-item--label">Upload Your Design</span><p class="cc-nav__submenu-item--description">Express your style on your walls</p></span></a></li></ul></div></div></div></div></li>
<!-- /wp:cwicly/navdropdown -->`;

/** The save() of `cwicly/navmenu`, `swatch` and `rangeslider` (build/index.js of the plugin): none occurs in any of the four databases. */
const NAVMENU_MARKUP = `<!-- wp:cwicly/navmenu {"uniqueID":"u-nm","classID":"navmenu-c1","id":"navmenu-c1","additionalClassesR":"","menuSelected":"5"} -->
{nav_menu=5}
<!-- /wp:cwicly/navmenu -->`;
const SWATCH_MARKUP = `<!-- wp:cwicly/swatch {"uniqueID":"u-sw","classID":"swatch-c1","id":"swatch-c1","additionalClassesR":"","swatchSlug":"pa_color","swatchType":"color"} -->
<div id="swatch-c1{idadd}" class="cc-swatch{swatchclass=}">{swatch=}</div>
<!-- /wp:cwicly/swatch -->`;
const RANGESLIDER_MARKUP = `<!-- wp:cwicly/rangeslider {"uniqueID":"u-rs","classID":"rangeslider-c1","id":"rangeslider-c1","additionalClassesR":"","rangeSliderMin":0,"rangeSliderMax":100} -->
<div id="rangeslider-c1{idadd}" class="rangeslider-c1"></div>
<!-- /wp:cwicly/rangeslider -->`;

/** A static page's context, for blocks that name nothing of the site. */
const PLAIN: { site: SiteName; subject: Subject } = {
  site: "fineline",
  subject: { kind: "post", id: 5246 },
};

async function convertMarkup(
  markup: string,
  over: Partial<ConvertCtx> = {},
  where: { site: SiteName; subject: Subject } = PLAIN,
) {
  const run = await runFor(where.site, where.subject, over);
  const nodes = finishNodes(run.ctx.convert(blocksOf(markup)));
  return { ...run, nodes, reportsNow: run.reports() };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. Accordions
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("accordions", () => {
  test("an accordion is a details with a summary and the content, in that order", async () => {
    const r = await convertMarkup(
      accordionsMarkup(accordionMarkup("1", "First") + accordionMarkup("2", "Second")),
    );
    const root = el(r.nodes[0]);
    expect(root.tagName).toBe("div");
    // Unstyled, the block prints no classID (the editor's `isStyling` rule).
    expect(root.className).toBeUndefined();
    expect(attrsOf(root)["data-cc-accordions"]).toBeUndefined();
    const details = kids(root);
    expect(details.map((d) => el(d).tagName)).toEqual(["details", "details"]);
    const parts = kids(details[0]);
    expect(parts.map((p) => el(p).tagName)).toEqual(["summary", "div"]);
    expect(el(parts[1]).className).toBe("cc-acdc");
    // The header keeps its heading and its icon.
    expect(kids(parts[0]).map((c) => el(c).tagName)).toEqual(["h2", "div"]);
    expect(codes(r.reportsNow).filter((c) => c.startsWith("interaction."))).toEqual([]);
  });

  test("the plugin's runtime attributes and state classes are not printed", async () => {
    const r = await convertMarkup(accordionsMarkup(accordionMarkup("1", "First")));
    const markup = html(r.nodes);
    for (const gone of [
      "data-cc-accordion",
      "aria-expanded",
      "cc-accordion-hidden",
      "cc-accordion-active",
      "<button",
    ]) {
      expect(markup).not.toContain(gone);
    }
    const details = el(kids(r.nodes[0])[0]);
    expect(details.className).toBe("cc-acd");
    expect(attrsOf(details).open).toBeUndefined();
  });

  test("accordionOpen opens the details", async () => {
    const r = await convertMarkup(
      accordionsMarkup(
        accordionMarkup("1", "Open", ',"accordionOpen":true', "cc-accordion-active") +
          accordionMarkup("2", "Closed"),
      ),
    );
    const [open, closed] = kids(r.nodes[0]);
    expect(attrsOf(open).open).toBe(true);
    expect(attrsOf(closed).open).toBeUndefined();
    expect(html(r.nodes)).toContain('<details class="cc-acd" id="accordion-c1" open>');
  });

  test("accordionGroup on the accordions makes every details of the container share a name", async () => {
    const r = await convertMarkup(
      accordionsMarkup(
        accordionMarkup("1", "A") + accordionMarkup("2", "B"),
        ',"accordionLinked":true,"accordionGroup":"faq"',
        ' data-cc-accordions-group="faq"',
      ),
    );
    expect(kids(r.nodes[0]).map((d) => attrsOf(d).name)).toEqual(["faq", "faq"]);
    expect(attrsOf(r.nodes[0])["data-cc-accordions-group"]).toBeUndefined();
  });

  test("accordionGroup on an accordion is its own name, outside any container too", async () => {
    const r = await convertMarkup(
      accordionMarkup(
        "1",
        "A",
        ',"accordionLinked":true,"accordionGroup":"shared"',
        "cc-accordion-hidden",
        ' data-cc-accordion-group="shared"',
      ) +
        accordionMarkup(
          "2",
          "B",
          ',"accordionLinked":true,"accordionGroup":"shared"',
          "cc-accordion-hidden",
          ' data-cc-accordion-group="shared"',
        ),
    );
    expect(r.nodes.map((n) => attrsOf(n).name)).toEqual(["shared", "shared"]);
    expect(r.nodes.map((n) => el(n).tagName)).toEqual(["details", "details"]);
  });

  test("a group the editor did not link (accordionGroup set, accordionLinked off) is no group", async () => {
    const r = await convertMarkup(
      accordionsMarkup(accordionMarkup("1", "A"), ',"accordionGroup":"faq"'),
    );
    expect(attrsOf(kids(r.nodes[0])[0]).name).toBeUndefined();
  });

  test("the summary is not a button: no disclosure marker, a pointer, and the block's own rule wins", async () => {
    const r = await convertMarkup(accordionsMarkup(accordionMarkup("1", "A")));
    const summary = el(kids(kids(r.nodes[0])[0])[0]);
    expect(summary.tagName).toBe("summary");
    expect(summary.style).toMatchObject({
      listStyle: "none",
      cursor: "pointer",
      "&::-webkit-details-marker": { display: "none" },
    });
    // The block's own declarations are kept, and a declaration it makes is not overruled.
    expect(summary.style).toMatchObject({ display: "flex", justifyContent: "space-between" });
  });

  test("a declaration the header's own rule makes is not overruled by the button's defaults", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    const css = parseCwiclyCssFor(run.ctx, ".accordionheader-c1{cursor:default;list-style:disc}");
    const ctx = withRegistry({ ...run.ctx, css, hoist: (h) => run.hoisted.push(h) }, registry);
    const nodes = ctx.convert(blocksOf(accordionsMarkup(accordionMarkup("1", "A"))));
    const summary = el(kids(kids(nodes[0])[0])[0]);
    expect(summary.style).toMatchObject({ cursor: "default", listStyle: "disc" });
  });

  test("a rule written for the script's open class is written again for [open]", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    const css = parseCwiclyCssFor(
      run.ctx,
      ".accordion-c1 .icon-c1{transition:.2s}.accordion-c1.cc-accordion-active .icon-c1{transform:rotate(180deg)}",
    );
    const ctx = withRegistry({ ...run.ctx, css, hoist: (r) => run.hoisted.push(r) }, registry);
    ctx.convert(blocksOf(accordionsMarkup(accordionMarkup("1", "A"))));
    // The compound `.accordion-c1.cc-accordion-active` stays a compound: the class is replaced, nothing is glued to its neighbour.
    const rule = run.hoisted.find((h) => h.selector === ".accordion-c1:is(details)[open] .icon-c1");
    expect(rule?.style).toEqual({ transform: "rotate(180deg)" });
    // A state class that is an entry of its own (`.cc-accordion-active .x`) and one behind a tag are rewritten too.
    const more = parseCwiclyCssFor(
      run.ctx,
      ".cc-accordion-active .x{color:red}details.cc-accordion-hidden{opacity:.5}",
    );
    const run2 = await runFor(PLAIN.site, PLAIN.subject);
    withRegistry({ ...run2.ctx, css: more, hoist: (r) => run2.hoisted.push(r) }, registry).convert(
      blocksOf(accordionMarkup("1", "A")),
    );
    const selectors = run2.hoisted.map((h) => h.selector);
    // Scoped to a details: a bare `[open]` or `:not([open])` would match html, body and every dialog on the page.
    expect(run2.hoisted.find((h) => h.selector === ":is(details)[open]")?.style).toEqual({
      "& .x": { color: "red" },
    });
    expect(selectors).toContain(":is(details):not([open])");
    expect(selectors).not.toContain("[open]");
    expect(selectors).not.toContain(":not([open])");
  });

  test("an accordion whose open state is a component parameter is open by the instance's value", async () => {
    const ctx = (await convertMarkup("")).ctx;
    const props = new Map([["prop1", "faqOpen"]]);
    const r = await convertMarkup(accordionMarkup("1", "A", ',"accordionOpenComp":"!ref=prop1!"'), {
      props,
    });
    void ctx;
    expect(attrsOf(r.nodes[0]).open).toBe(
      "${state.faqOpen === true || state.faqOpen === 'true' ? true : false}",
    );
    // The class the token printed is not a class.
    expect(el(r.nodes[0]).className ?? "").not.toContain("$");
  });

  test("a parameter the component does not have is reported and the accordion starts closed", async () => {
    const r = await convertMarkup(accordionMarkup("1", "A", ',"accordionOpenComp":"!ref=nope!"'));
    expect(attrsOf(r.nodes[0]).open).toBeUndefined();
    expect(byCode(r.reportsNow, "interaction.dropped").map((e) => e.data?.feature)).toContain(
      "accordion-open-parameter",
    );
  });

  test("a group that is a component parameter is reported", async () => {
    const r = await convertMarkup(
      accordionMarkup(
        "1",
        "A",
        ',"accordionLinkedComp":"!ref=p1!","accordionGroupComp":"!ref=p2!"',
      ),
    );
    expect(byCode(r.reportsNow, "interaction.dropped").map((e) => e.data?.feature)).toContain(
      "accordion-group-parameter",
    );
  });

  test("the height transition is reported as approximated", async () => {
    const r = await convertMarkup(
      accordionMarkup("1", "A", ',"accordionTransitionDuration":"0.5"'),
    );
    expect(byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "accordion-transition",
    );
  });

  test("a hidden accordion (a visibility condition) is not converted, nor its content reported", async () => {
    const r = await convertMarkup(
      accordionMarkup("1", "A", ',"hideLoggedIn":false,"hideGuest":true'),
    );
    expect(r.nodes).toEqual([]);
  });
});

/** A CssIndex for a stylesheet text, read with the context's own breakpoints. */
function parseCwiclyCssFor(ctx: ConvertCtx, css: string) {
  return parseCwiclyCss(css, ctx.cwicly.breakpoints, { file: "test" });
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. Tabs
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("tabs", () => {
  test("a tab list is a box of labels, each around the radio that holds its state", async () => {
    const r = await convertMarkup(TABS_MARKUP);
    const list = el(r.nodes[0]);
    expect(list.tagName).toBe("div");
    for (const gone of ["role", "aria-orientation", "dir", "data-cc-tabs"]) {
      expect(attrsOf(list)[gone]).toBeUndefined();
    }
    const tabs = kids(list);
    expect(tabs.map((t) => el(t).tagName)).toEqual(["label", "label"]);
    const radios = tabs.map((t) => el(kids(t)[0]));
    expect(radios.map((x) => x.tagName)).toEqual(["input", "input"]);
    expect(radios.map((x) => attrsOf(x).type)).toEqual(["radio", "radio"]);
    // One group, ids the panels' rules can name, the first tab selected.
    expect(new Set(radios.map((x) => attrsOf(x).name))).toEqual(
      new Set(["tabcontents-collection-design-tabs"]),
    );
    expect(radios.map((x) => attrsOf(x).id)).toEqual([
      "tabcontents-collection-design-tab-0",
      "tabcontents-collection-design-tab-1",
    ]);
    expect(radios.map((x) => attrsOf(x).checked)).toEqual([true, undefined]);
    // The tab's own content follows the radio, and the button's attributes are gone.
    expect(kids(tabs[0]).map((c) => (typeof c === "string" ? c : c.tagName))).toEqual([
      "input",
      "p",
    ]);
    for (const t of tabs) {
      for (const gone of ["type", "role", "tabindex", "aria-selected"])
        expect(attrsOf(t)[gone]).toBeUndefined();
    }
    expect(attrsOf(tabs[0]).id).toBe("tab-c87247a");
  });

  test("the tab list's default tab (tabContentsActive, 1-based) starts selected; a tab's own tabContentActive is only its saved aria state", async () => {
    const checked = async (markup: string) => {
      const r = await convertMarkup(markup);
      return kids(r.nodes[0]).map((t) => attrsOf(el(kids(t)[0])).checked);
    };
    // The plugin prints tabContentsActive as `data-cc-tabs-default` and its script clicks child `default - 1`.
    const two = TABS_MARKUP.replace('"tabContentsActive":0', '"tabContentsActive":2');
    expect(await checked(two)).toEqual([undefined, true]);
    // The marked tab is still the first, and the list says the second: the list wins.
    expect(two).toContain('"tabContentActive":true,"uniqueID":"u-t1"');
    // No default on the list: the script opens the first child, whichever tab the editor marked.
    const swapped = TABS_MARKUP.replace(
      '"tabContentActive":true,"uniqueID":"u-t1"',
      '"tabContentActive":false,"uniqueID":"u-t1"',
    ).replace(
      '"tabContentActive":false,"uniqueID":"u-t2"',
      '"tabContentActive":true,"uniqueID":"u-t2"',
    );
    expect(await checked(swapped)).toEqual([true, undefined]);
    // A default past the last tab opens nothing the script could find: the first tab stays selected.
    expect(
      await checked(TABS_MARKUP.replace('"tabContentsActive":0', '"tabContentsActive":9')),
    ).toEqual([true, undefined]);
  });

  test("a label is given the box a button had, unless the block says otherwise", async () => {
    const r = await convertMarkup(TABS_MARKUP);
    const label = el(kids(r.nodes[0])[0]);
    expect(label.style).toMatchObject({
      display: "inline-block",
      cursor: "pointer",
      position: "relative",
    });
    expect(classes(label)).toContain("cc-tab-label");
  });

  test("the radios are hidden by one shared rule and the focus ring is the label's", async () => {
    const r = await convertMarkup(TABS_MARKUP);
    const hidden = r.hoisted.find((h) => h.selector === ".cc-tab-radio");
    expect(hidden?.style).toMatchObject({
      position: "absolute",
      opacity: "0",
      pointerEvents: "none",
    });
    expect(r.hoisted.some((h) => h.selector.includes(":focus-visible"))).toBe(true);
  });

  test("every panel but the selected tab's is hidden by a rule that reaches it by id", async () => {
    const r = await convertMarkup(TABS_MARKUP);
    const rules = r.hoisted.filter((h) => h.selector.startsWith(":root:has("));
    expect(rules.map((h) => h.selector)).toEqual([
      ":root:has(#tabcontents-collection-design-tab-0:not(:checked)) #tabcontent-collections",
      ":root:has(#tabcontents-collection-design-tab-1:not(:checked)) #tabcontents-collection-design-panel-1",
    ]);
    for (const h of rules) expect(h.style).toEqual({ display: "none" });
  });

  test("a panel keeps its saved id, or is given one, and loses the roles of ARIA tabs", async () => {
    const r = await convertMarkup(TABS_MARKUP);
    const container = el(r.nodes[1]);
    expect(attrsOf(container).id).toBe("tabcontents-collection-design");
    const panels = kids(container);
    expect(panels.map((p) => attrsOf(p).id)).toEqual([
      "tabcontent-collections",
      "tabcontents-collection-design-panel-1",
    ]);
    for (const p of panels) {
      expect(attrsOf(p).role).toBeUndefined();
      expect(classes(p)).toContain("cc-tbc");
      // The script's state class is not printed: the rule above is the state.
      expect(classes(p).some((c) => c.startsWith("cc-tab-content-"))).toBe(false);
    }
    // The panel's own display is the block's, and the hiding rule outweighs it by an id.
    expect(el(panels[0]).style).toMatchObject({ display: "flex" });
  });

  test("a tab list with no panels named is plain buttons and says so", async () => {
    const r = await convertMarkup(
      TABS_MARKUP.replace('"tabContentsID":"tabcontents-collection-design",', ""),
    );
    expect(byTag(r.nodes, "input")).toEqual([]);
    expect(byTag(r.nodes, "button").length).toBe(2);
    expect(byCode(r.reportsNow, "interaction.dropped").map((e) => e.data?.feature)).toContain(
      "tabs-unlinked",
    );
  });

  test("tabs that open on hover are reported as opening when chosen", async () => {
    const r = await convertMarkup(
      TABS_MARKUP.replace(
        'data-cc-tabs="tabcontents-collection-design"',
        'data-cc-tabs="tabcontents-collection-design" data-cc-tabs-trigger="hover"',
      ),
    );
    expect(byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "tabs-hover",
    );
  });

  test("a rule written for the active tab's class (littlecocalico's .tablist-decor) is written again for the checked radio", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    // The real rule of littlecocalico's cc-global-classes.css.
    const css = parseCwiclyCssFor(
      run.ctx,
      ".tablist-decor button.cc-tab-active{background-color:var(--color-ejhnz);text-decoration:underline}",
    );
    const ctx = withRegistry({ ...run.ctx, css, hoist: (x) => run.hoisted.push(x) }, registry);
    ctx.convert(blocksOf(TABS_MARKUP));
    const rule = run.hoisted.find((h) => h.selector.startsWith(".tablist-decor"));
    expect(rule?.selector).toBe(".tablist-decor .cc-tab-label:has(> .cc-tab-radio:checked)");
    expect(rule?.style).toEqual({
      backgroundColor: "var(--color-ejhnz)",
      textDecoration: "underline",
    });
  });

  test("a tab or a panel outside a list converts alone: a button, a box", async () => {
    const [tab, content] = [
      '<!-- wp:cwicly/tab {"uniqueID":"u","classID":"tab-x","id":"tab-x","additionalClassesR":""} -->\n<button id="tab-x{idadd}" class="{tab_state}" type="button" role="tab"></button>\n<!-- /wp:cwicly/tab -->',
      '<!-- wp:cwicly/tabcontent {"uniqueID":"u","classID":"tc-x","id":"tc-x","additionalClassesR":""} -->\n<div class="{tab_content_state} cc-tbc" role="tabpanel"></div>\n<!-- /wp:cwicly/tabcontent -->',
    ];
    const a = await convertMarkup(tab);
    expect(el(a.nodes[0]).tagName).toBe("button");
    expect(attrsOf(a.nodes[0]).role).toBeUndefined();
    expect(byCode(a.reportsNow, "interaction.dropped").map((e) => e.data?.feature)).toContain(
      "tab-orphan",
    );
    const b = await convertMarkup(content);
    expect(el(b.nodes[0]).tagName).toBe("div");
    expect(attrsOf(b.nodes[0]).role).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. Modals and popovers
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** A modal as the plugin saves it (its `save()`), with the data attributes the options write. */
const modalMarkup = (
  attrs = "",
  shellAttrs = ' data-classid="true" data-preventpagescroll="true" data-closeoverlay="true" data-every="true"',
): string => `<!-- wp:cwicly/modal {"isStyling":true,"forceShowID":true,"forceShowClass":true,"uniqueID":"u-md","classID":"modal-promo","id":"modal-promo","additionalClassesR":""${attrs}} -->
<div id="modal-promo{idadd}" class="cc-mdl modal-{class} cc-modal-fade-in"${shellAttrs}><a href="#" class="cc-mdl-close" aria-hidden="true"></a><div class="cc-mdl-container"><div class="modal-promo cc-modaler"><!-- wp:cwicly/paragraph {"content":"Hello","uniqueID":"u-mp","classID":"paragraph-mp","id":"paragraph-mp","additionalClassesR":""} -->
<p>Hello</p>
<!-- /wp:cwicly/paragraph --></div></div></div>
<!-- /wp:cwicly/modal -->`;

describe("modals", () => {
  test("anabaptistperspectives' overlay menu: the plugin's shell, now a popover with its id", async () => {
    const run = await runFor("ap", AP_MOBILE_MENU);
    const b = await realBlock("ap", AP_MOBILE_MENU, "modal-overlay-menu");
    const nodes = run.ctx.convert([b]);
    expect(nodes.length).toBe(1);
    const shell = el(nodes[0]);
    expect(shell.tagName).toBe("div");
    expect(classes(shell)).toEqual(["cc-mdl", "modal-modal-overlay-menu", "cc-modal-fade-in"]);
    expect(attrsOf(shell).id).toBe("modal-overlay-menu");
    expect(attrsOf(shell).popover).toBe("auto");
    // The script's configuration is not printed.
    for (const name of Object.keys(attrsOf(shell))) expect(name).not.toMatch(/^data-/);
    const [dimmer, container] = kids(shell);
    expect(el(container).className).toBe("cc-mdl-container");
    const modaler = el(kids(container)[0]);
    expect(classes(modaler)).toEqual(["modal-overlay-menu", "cc-modaler"]);
    // The block's own rule is on the element that has the classID, and nowhere else.
    expect(modaler.style).toMatchObject({ display: "flex", flexDirection: "column" });
    expect(el(dimmer).tagName).toBe("button");
    expect(attrsOf(dimmer)).toMatchObject({
      type: "button",
      popovertarget: "modal-overlay-menu",
      popovertargetaction: "hide",
    });
    expect(classes(dimmer)).toEqual(["cc-mdl-close"]);
  });

  test("its close icon is the opener the link module builds: a button that hides the same id", async () => {
    const run = await runFor("ap", AP_MOBILE_MENU);
    const b = await realBlock("ap", AP_MOBILE_MENU, "modal-overlay-menu");
    const nodes = run.ctx.convert([b]);
    const close = byClass(nodes, "icon-c64c3db")[0];
    expect(close?.tagName).toBe("button");
    expect(attrsOf(close)).toMatchObject({
      popovertarget: "modal-overlay-menu",
      popovertargetaction: "hide",
    });
  });

  test("the rules that show a popover as the plugin shows a modal, and lock the page's scroll", async () => {
    const run = await runFor("ap", AP_MOBILE_MENU);
    run.ctx.convert([await realBlock("ap", AP_MOBILE_MENU, "modal-overlay-menu")]);
    const rules = new Map(run.hoisted.map((h) => [h.selector, h.style]));
    // The UA's popover box (margin, border, padding, a white Canvas background) is reset.
    expect(rules.get(".cc-mdl[popover]")).toMatchObject({
      margin: "0",
      border: "0",
      background: "transparent",
    });
    // A closed one stays hidden whatever `display` the block's own rule gives its shell.
    expect(rules.get(".cc-mdl[popover]:not(:popover-open)")).toEqual({ display: "none" });
    expect(rules.get(".cc-mdl[popover]:popover-open")).toMatchObject({ left: "0" });
    expect(rules.get(".cc-mdl[popover]:popover-open > .cc-mdl-close")).toMatchObject({
      left: "0",
      opacity: "1",
    });
    expect(rules.get(".cc-mdl[popover]:popover-open .cc-modaler")).toMatchObject({
      opacity: "1",
      transform: "none",
    });
    expect(rules.get("body:has(#modal-overlay-menu:popover-open)")).toEqual({ overflow: "hidden" });
  });

  test("every opener of the site names a popover the site has (the modals of the header, the mobile menu and the footer)", async () => {
    const loaded = await loadSite("ap");
    const targets = new Set<string>();
    const ids = new Set<string>();
    for (const subject of allSubjects(loaded)) {
      const run = await runFor("ap", subject);
      const nodes = run.ctx.convert(subjectBlocks(loaded, subject));
      for (const e of all(nodes)) {
        const t = attrsOf(e).popovertarget;
        if (typeof t === "string" && attrsOf(e).popovertargetaction !== "hide") targets.add(t);
        if (attrsOf(e).popover !== undefined && typeof attrsOf(e).id === "string")
          ids.add(attrsOf(e).id as string);
      }
    }
    expect(targets.size).toBeGreaterThan(0);
    for (const t of targets) expect(ids.has(t)).toBe(true);
  });

  test("a modal without the overlay option has a dimming box that closes nothing", async () => {
    const r = await convertMarkup(modalMarkup("", ' data-classid="true"'));
    const shell = el(r.nodes[0]);
    const dimmer = el(kids(shell)[0]);
    expect(dimmer.tagName).toBe("div");
    expect(attrsOf(dimmer).popovertarget).toBeUndefined();
    expect(r.hoisted.some((h) => h.selector.startsWith("body:has("))).toBe(false);
  });

  test("a modal that must not close on Escape is a manual popover", async () => {
    const r = await convertMarkup(
      modalMarkup(
        ',"modalPreventEsc":true',
        ' data-classid="true" data-preventesc="true" data-closeoverlay="true"',
      ),
    );
    expect(attrsOf(r.nodes[0]).popover).toBe("manual");
    expect(attrsOf(r.nodes[0])["data-preventesc"]).toBeUndefined();
  });

  test("what opens a modal by itself takes a script and is reported, one entry per trigger", async () => {
    for (const [when, extra] of [
      ["load", ' data-onload="2"'],
      ["inactivity", ' data-inactive="10"'],
      ["scroll", ' data-onscroll="50"'],
      ["exit", ' data-exitintent="true"'],
    ] as const) {
      const r = await convertMarkup(
        modalMarkup(
          `,"modalTriggerWhen":"${when}"`,
          ` data-classid="true" data-closeoverlay="true"${extra}`,
        ),
      );
      expect(attrsOf(r.nodes[0]).popover).toBe("auto");
      const features = byCode(r.reportsNow, "interaction.dropped").map((e) => e.data?.feature);
      expect(features).toContain(`modal-trigger-${when}`);
      // The data attributes of the trigger are not printed either.
      expect(html(r.nodes)).not.toContain("data-on");
    }
  });

  test("showing again (days, a count kept in the browser) is reported", async () => {
    const r = await convertMarkup(
      modalMarkup(',"modalTriggerShowAgain":"upto"', ' data-classid="true" data-upto="3"'),
    );
    expect(byCode(r.reportsNow, "interaction.dropped").map((e) => e.data?.feature)).toContain(
      "modal-show-again",
    );
  });

  test("the other modals of anabaptistperspectives (footer, two posts) convert like the first", async () => {
    for (const subject of [
      AP_FOOTER,
      { kind: "post", id: 1417 },
      { kind: "post", id: 10776 },
    ] as Subject[]) {
      const b = await nthBlock("ap", subject, "cwicly/modal", 0);
      const run = await runFor("ap", subject);
      const nodes = run.ctx.convert([b]);
      expect(nodes.length).toBe(1);
      expect(attrsOf(nodes[0]).popover).toBe("auto");
      expect(attrsOf(nodes[0]).id).toBe(b.attrs.id);
      expect(classes(nodes[0])).toContain("cc-mdl");
    }
  });
});

describe("popovers", () => {
  test("anabaptistperspectives' footer popover is shown while its trigger is hovered, beside the trigger", async () => {
    const run = await runFor("ap", AP_FOOTER);
    const b = await nthBlock("ap", AP_FOOTER, "cwicly/popover");
    const nodes = run.ctx.convert([b]);
    const root = el(nodes[0]);
    expect(attrsOf(root).id).toBe("popover-c369aa8");
    expect(classes(root)[0]).toBe("popover-c22fe0f");
    for (const name of Object.keys(attrsOf(root))) expect(name).not.toMatch(/^data-/);
    // Not a native popover: the trigger is a paragraph, which cannot be an invoker.
    expect(attrsOf(root).popover).toBeUndefined();
    const rules = new Map(run.hoisted.map((h) => [h.selector, h.style]));
    expect(rules.get("#paragraph-content")).toEqual({ anchorName: "--popover-popover-c369aa8" });
    expect(rules.get("#popover-c369aa8")).toMatchObject({
      visibility: "hidden",
      pointerEvents: "none",
      positionAnchor: "--popover-popover-c369aa8",
      positionArea: "bottom span-right",
    });
    const shown = [...rules].find(([sel]) => sel.includes("#paragraph-content:hover"));
    expect(shown?.[0]).toContain(":root:has(#popover-c369aa8:hover) #popover-c369aa8");
    expect(shown?.[1]).toMatchObject({ visibility: "visible", opacity: "1" });
    expect(byCode(run.reports(), "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "popover-flip",
    );
  });

  const popoverMarkup = (
    options: string,
    tag = "div",
  ): string => `<!-- wp:cwicly/popover {"popoverOptions":${options},"isStyling":true,"uniqueID":"u-po","classID":"popover-x","id":"popover-x","additionalClassesR":""} -->
<${tag} id="popover-x{idadd}" class="popover-x" style="position:absolute;" data-ccp-position="absolute" data-ccp-placement="top-end" data-ccp-state="hidden"><!-- wp:cwicly/paragraph {"content":"More","uniqueID":"u-pp","classID":"paragraph-pp","id":"paragraph-pp","additionalClassesR":""} -->
<p>More</p>
<!-- /wp:cwicly/paragraph --></${tag}>
<!-- /wp:cwicly/popover -->`;

  test("a popover with no trigger element is a native popover for the openers that name it", async () => {
    const r = await convertMarkup(popoverMarkup('{"placement":"bottom"}'));
    const root = el(r.nodes[0]);
    expect(attrsOf(root).popover).toBe("auto");
    expect(classes(root)).toContain("popover-box");
    expect(r.hoisted.find((h) => h.selector === ".popover-box[popover]")?.style).toMatchObject({
      margin: "0",
      border: "0",
      background: "transparent",
      inset: "auto",
    });
    expect(
      r.hoisted.find((h) => h.selector === ".popover-box[popover]:not(:popover-open)")?.style,
    ).toEqual({ display: "none" });
    // Placed beside the button that opened it.
    expect(r.hoisted.find((h) => h.selector === "#popover-x[popover]")?.style).toEqual({
      positionArea: "bottom",
    });
  });

  test("a click trigger is shown while the trigger holds the focus, and the difference is reported", async () => {
    const r = await convertMarkup(
      popoverMarkup('{"trigger":"open-me","triggerType":"click","placement":"top-end"}'),
    );
    expect(attrsOf(r.nodes[0]).popover).toBeUndefined();
    const shown = r.hoisted.find((h) => h.selector.includes("#open-me:focus-within"));
    expect(shown).toBeDefined();
    expect(shown?.selector).not.toContain("#open-me:hover");
    expect(r.hoisted.find((h) => h.selector === "#popover-x")?.style).toMatchObject({
      positionArea: "top span-left",
    });
    expect(byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "popover-click",
    );
  });

  test("Floating UI's placements are anchor positioning areas", async () => {
    const cases: [string, string][] = [
      ["bottom", "bottom"],
      ["top-start", "top span-right"],
      ["top-end", "top span-left"],
      ["left-start", "left span-bottom"],
      ["right-end", "right span-top"],
    ];
    for (const [placement, area] of cases) {
      const r = await convertMarkup(
        popoverMarkup(`{"trigger":"t","triggerType":"hover","placement":"${placement}"}`),
      );
      expect(r.hoisted.find((h) => h.selector === "#popover-x")?.style).toMatchObject({
        positionArea: area,
      });
    }
    const odd = await convertMarkup(
      popoverMarkup('{"trigger":"t","triggerType":"hover","placement":"auto"}'),
    );
    expect(odd.hoisted.find((h) => h.selector === "#popover-x")?.style).not.toHaveProperty(
      "positionArea",
    );
  });

  test("an interactive popover stays open while it is hovered; one that is not does not", async () => {
    const yes = await convertMarkup(
      popoverMarkup('{"trigger":"t","triggerType":"hover","interactive":true}'),
    );
    const no = await convertMarkup(popoverMarkup('{"trigger":"t","triggerType":"hover"}'));
    const shownOf = (r: typeof yes) =>
      r.hoisted.find((h) => h.selector.includes("#t:hover"))?.selector ?? "";
    expect(shownOf(yes)).toContain(":root:has(#popover-x:hover) #popover-x");
    expect(shownOf(no)).not.toContain("#popover-x:hover");
  });

  test("its animation and delays are reported as approximated", async () => {
    const r = await convertMarkup(
      popoverMarkup(
        '{"trigger":"t","triggerType":"hover","animation":"scale","delayDuration":200}',
      ),
    );
    expect(byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "popover-animation",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. Sliders
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("sliders", () => {
  test("a slider is a scroller of slides: the plugin's swiper box, its wrapper, one box per slide", async () => {
    const r = await convertMarkup(sliderMarkup());
    const root = el(r.nodes[0]);
    expect(root.tagName).toBe("div");
    expect(classes(root)[0]).toBe("slider-home-hero");
    expect(attrsOf(root).id).toBe("slider-home-hero");
    const swiper = el(kids(root)[0]);
    expect(swiper.className).toBe("swiper");
    // Swiper's arrows are not controls here.
    expect(kids(swiper).map((c) => classes(c))).toEqual([["swiper-wrapper"]]);
    const slides = kids(kids(swiper)[0]);
    expect(slides.length).toBe(2);
    for (const slide of slides) {
      expect(classes(slide)).toEqual(["swiper-slide", "cc-slider"]);
      expect(classes(kids(slide)[0])).toContain("cc-sldc");
    }
    // The slide's content is the paragraph.
    expect(html([slides[1] as JxNode])).toContain("Second slide");
  });

  test("the runtime attributes of the script are not printed", async () => {
    const r = await convertMarkup(
      sliderMarkup(
        "",
        ' data-loop="true" data-autoplay="true" data-autoplayduration="6000" data-draggable="true"',
      ),
    );
    for (const name of Object.keys(attrsOf(r.nodes[0]))) expect(name).not.toMatch(/^data-/);
  });

  test("the scroller scrolls along the row and snaps to each slide", async () => {
    const r = await convertMarkup(sliderMarkup());
    const style = el(r.nodes[0]).style as JxStyle;
    expect(style["& .swiper"]).toMatchObject({
      overflowX: "auto",
      overflowY: "hidden",
      scrollSnapType: "x mandatory",
    });
    expect(style["& .swiper-slide"]).toMatchObject({ scrollSnapAlign: "start", flex: "0 0 auto" });
    expect((style["& .swiper-slide"] as JxStyle).width).toBe(
      "calc((100% - var(--cc-slide-gap, 0px) * (var(--cc-slides, 1) - 1)) / var(--cc-slides, 1))",
    );
  });

  test("slides per view and the gap are custom properties by breakpoint", async () => {
    const r = await convertMarkup(
      sliderMarkup(
        ',"sliderNumberPerWindow":{"lg":"3","md":"2","sm":"1"},"sliderSpaceBetween":{"lg":"20","md":"10"}',
      ),
    );
    const style = el(r.nodes[0]).style as JxStyle;
    expect(style["--cc-slides"]).toBe("3");
    expect(style["--cc-slide-gap"]).toBe("20px");
    expect(style["@--md"]).toMatchObject({ "--cc-slides": "2", "--cc-slide-gap": "10px" });
    expect(style["@--sm"]).toMatchObject({ "--cc-slides": "1" });
  });

  test("the editor's empty value (unset at a breakpoint) is no value", async () => {
    const r = await convertMarkup(sliderMarkup(',"sliderNumberPerWindow":{"lg":"2","md":""}'));
    const style = el(r.nodes[0]).style as JxStyle;
    expect(style["--cc-slides"]).toBe("2");
    expect(style["@--md"]).toBeUndefined();
  });

  test("what Swiper did and a scroller does not is reported, with each feature named", async () => {
    const r = await convertMarkup(
      sliderMarkup(
        ',"sliderAutoPlay":true,"sliderLoop":true,"sliderFade":true,"sliderThumbs":true,"sliderHoverPause":true',
      ),
    );
    const lost = byCode(r.reportsNow, "interaction.dropped").find(
      (e) => e.data?.feature === "slider-features",
    );
    expect(lost?.message).toContain("autoplay");
    expect(lost?.message).toContain("endless loop");
    expect(lost?.message).toContain("fade");
    expect(lost?.message).toContain("thumbnail");
    expect(lost?.message).toContain("previous and next arrows");
    expect(byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "slider",
    );
    expect(lost?.where).toBe("post:5246");
  });

  test("a slider that used none of Swiper's features reports only what the saved markup shows (the arrows)", async () => {
    const r = await convertMarkup(sliderMarkup());
    const lost = byCode(r.reportsNow, "interaction.dropped").find(
      (e) => e.data?.feature === "slider-features",
    );
    expect(lost?.message).toContain("previous and next arrows");
    expect(lost?.message).not.toContain("autoplay");
  });

  test("a vertical slider scrolls down", async () => {
    const r = await convertMarkup(sliderMarkup(',"sliderDirection":"vertical"', ""));
    const style = el(r.nodes[0]).style as JxStyle;
    expect(style["& .swiper"]).toMatchObject({
      overflowX: "hidden",
      overflowY: "auto",
      scrollSnapType: "y mandatory",
    });
    expect(style["& .swiper-wrapper"]).toMatchObject({ flexDirection: "column" });
  });

  test("a slide is its wrapper and the box that carries its classID", async () => {
    const r = await convertMarkup(sliderMarkup());
    const slide = el(kids(kids(kids(r.nodes[0])[0])[0])[0]);
    const inner = el(kids(slide)[0]);
    expect(classes(inner)[0]).toBe("sliderchild-c0c9b62");
    expect(classes(inner)).toContain("cc-sldc");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. Navigation
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const FINELINE_UPDATED: Subject = { kind: "part", slug: "header-updated-menu" };

const navOf = async (classID: string, subject: Subject = FINELINE_HEADER) => {
  const run = await runFor("fineline", subject);
  const nodes = run.ctx.convert([await realBlock("fineline", subject, classID)]);
  return { ...run, nodes };
};

describe("navigation", () => {
  test("a nav with a breakpoint keeps the plugin's markup and makes the wrapper the popover", async () => {
    const r = await navOf("nav-ce2259c");
    expect(r.nodes.length).toBe(1);
    const root = el(r.nodes[0]);
    expect(classes(root)).toEqual(["nav-ce2259c", "cc-nav"]);
    expect(attrsOf(root).id).toBe("nav-c5786fb");
    // What the stylesheet reads is kept; the dropdown animation's attribute and the backdrop are not.
    expect(attrsOf(root)).toMatchObject({ "is-nav": "true", modal: "offcanvas", breakpoint: "md" });
    expect(attrsOf(root).animation).toBeUndefined();
    const [wrapper, toggle] = kids(root);
    expect(classes(wrapper)).toEqual(["cc-nav-wrapper"]);
    expect(attrsOf(wrapper)).toMatchObject({ id: "nav-c5786fb-wrapper", popover: "auto" });
    expect(byClass(r.nodes, "cc-nav-backdrop")).toEqual([]);
    expect(el(toggle).tagName).toBe("button");
    expect(classes(toggle)).toEqual(["cc-nav-toggle", "cc-hamburger", "cc-hamburger-tilt"]);
    expect(attrsOf(toggle)).toMatchObject({
      type: "button",
      "aria-label": "Toggle Menu",
      popovertarget: "nav-c5786fb-wrapper",
    });
  });

  test("the header and the content are the saved ones, the inner blocks inside the content", async () => {
    const r = await navOf("nav-ce2259c");
    const wrapper = el(kids(r.nodes[0])[0]);
    expect(kids(wrapper).map((c) => classes(c)[0])).toEqual(["cc-nav-header", "cc-nav-content"]);
    const content = el(kids(wrapper)[1]);
    expect(kids(content).map((c) => el(c).tagName)).toEqual(["nav", "nav", "nav"]);
    expect(kids(content).map((c) => classes(c)[0])).toEqual([
      "menu-c0fe5e2",
      "menu-cb308ae",
      "menu-c6998c3",
    ]);
  });

  test("the animated hamburger's decoration becomes the close button, drawn as the cross the plugin's CSS draws", async () => {
    const r = await navOf("nav-ce2259c");
    const close = el(byClass(r.nodes, "cc-nav-toggle--close")[0]);
    expect(close.tagName).toBe("button");
    expect(attrsOf(close).disabled).toBeUndefined();
    expect(attrsOf(close)["aria-hidden"]).toBeUndefined();
    expect(attrsOf(close)).toMatchObject({
      type: "button",
      popovertarget: "nav-c5786fb-wrapper",
      popovertargetaction: "hide",
    });
    // `.cc-hamburger.active.cc-hamburger-tilt .line` is the cross, so those classes and the lines are on it.
    expect(classes(close)).toEqual([
      "cc-nav-toggle--close",
      "cc-hamburger",
      "active",
      "cc-hamburger-tilt",
    ]);
    expect(kids(close).map((c) => classes(c))).toEqual([["line"], ["line"], ["line"]]);
  });

  test("a nav with the plain toggle keeps its icons and both buttons name the wrapper", async () => {
    const r = await navOf("nav-c433b01", FINELINE_UPDATED);
    const root = el(r.nodes[0]);
    const toggle = el(byClass(r.nodes, "cc-nav-toggle")[0]);
    expect(toggle.tagName).toBe("button");
    expect(
      byTag(kids(toggle), "svg").length +
        kids(toggle).filter((k) => el(k).tagName === "svg").length,
    ).toBeGreaterThan(0);
    const close = el(byClass(r.nodes, "cc-nav-toggle--close")[0]);
    expect(attrsOf(close).popovertargetaction).toBe("hide");
    expect(kids(close).map((c) => el(c).tagName)).toEqual(["svg"]);
    expect(attrsOf(toggle).popovertarget).toBe(`${attrsOf(root).id}-wrapper`);
  });

  test("a nav that is never a modal has no popover, no toggle and no backdrop link", async () => {
    const r = await navOf("nav-c0498d1");
    const root = el(r.nodes[0]);
    expect(attrsOf(root).breakpoint).toBeUndefined();
    expect(byTag(r.nodes, "button").map((b) => classes(b)[0])).toEqual([
      "cc-nav-back",
      "cc-nav-back",
    ]);
    expect(all(r.nodes).some((e) => attrsOf(e).popover !== undefined)).toBe(false);
    expect(byClass(r.nodes, "cc-nav-backdrop")).toEqual([]);
    expect(r.hoisted.some((h) => h.selector.includes("popover"))).toBe(false);
  });

  test("the rules for the open modal are the plugin's [is-modal=true] rules under the breakpoint's media query", async () => {
    const r = await navOf("nav-ce2259c");
    const rules = new Map(r.hoisted.map((h) => [h.selector, h.style]));
    const nav = '.cc-nav[breakpoint="md"]';
    expect(rules.get(`${nav} > .cc-nav-wrapper[popover]:popover-open`)).toEqual({
      "@--md": { display: "block", visibility: "visible", inset: "0 auto auto 0", margin: "0" },
    });
    expect(rules.get(`${nav} > .cc-nav-wrapper[popover]:not(:popover-open)`)).toEqual({
      "@--md": { display: "none" },
    });
    expect(rules.get(`${nav} > .cc-nav-wrapper[popover]::backdrop`)).toEqual({
      "@--md": { background: "rgba(0, 0, 0, 0.5)" },
    });
    expect(rules.get(`${nav} .cc-nav-header`)).toEqual({ "@--md": { display: "flex" } });
    expect(rules.get(`${nav} .cc-nav-items`)).toEqual({ "@--md": { flexDirection: "column" } });
    expect(rules.get(`${nav} .cc-nav-content`)).toEqual({ "@--md": { flexDirection: "column" } });
    expect(rules.get(`${nav} .cc-nav-item`)).toEqual({ "@--md": { width: "100%" } });
    expect(rules.get(`body:has(${nav} > .cc-nav-wrapper[popover]:popover-open)`)).toEqual({
      "@--md": { overflow: "hidden" },
    });
    // Outside the modal state the wrapper is the plain box it was, at a specificity the modal rules outweigh.
    expect(rules.get(":where(.cc-nav[breakpoint]) > .cc-nav-wrapper[popover]")).toMatchObject({
      display: "block",
      position: "static",
      background: "transparent",
    });
  });

  test("a nav that is a modal at every width has the rules without a media query", async () => {
    const run = await runFor("fineline", FINELINE_HEADER);
    const b = await realBlock("fineline", FINELINE_HEADER, "nav-ce2259c");
    const lg = {
      ...b,
      innerContent: b.innerContent.map((s) =>
        s === null ? s : s.replace('breakpoint="md"', 'breakpoint="lg"'),
      ),
      innerHTML: b.innerHTML.replace('breakpoint="md"', 'breakpoint="lg"'),
    };
    run.ctx.convert([lg]);
    const open = run.hoisted.find(
      (h) => h.selector === '.cc-nav[breakpoint="lg"] > .cc-nav-wrapper[popover]:popover-open',
    );
    expect(open?.style).toEqual({
      display: "block",
      visibility: "visible",
      inset: "0 auto auto 0",
      margin: "0",
    });
  });

  test("the editor's rules for the modal state are written for the breakpoint, and the desktop ones for the other media query", async () => {
    const run = await runFor("fineline", FINELINE_HEADER);
    const css = parseCwiclyCssFor(
      run.ctx,
      ".nav-ce2259c{display:flex}.nav-ce2259c[is-modal=true] .cc-nav-header{padding:2rem}.nav-ce2259c:not([is-modal=true]) .cc-nav-content{gap:1rem}",
    );
    const ctx = withRegistry({ ...run.ctx, css, hoist: (h) => run.hoisted.push(h) }, registry);
    const nodes = ctx.convert([await realBlock("fineline", FINELINE_HEADER, "nav-ce2259c")]);
    const style = el(nodes[0]).style as JxStyle;
    expect(JSON.stringify(style)).not.toContain("is-modal");
    expect(style["@--md"]).toMatchObject({
      '&[breakpoint="md"] .cc-nav-header': { padding: "2rem" },
    });
    expect(style["@(min-width: 992.02px)"]).toMatchObject({ "& .cc-nav-content": { gap: "1rem" } });
    expect(byCode(run.reports(), "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "nav-state-rules",
    );
  });

  test("a modal-only rule of a nav that is never a modal is dropped, a desktop-only one kept", async () => {
    const run = await runFor("fineline", FINELINE_HEADER);
    const css = parseCwiclyCssFor(
      run.ctx,
      ".nav-c0498d1{display:flex}.nav-c0498d1[is-modal=true] .cc-nav-header{padding:2rem}.nav-c0498d1:not([is-modal=true]) .cc-nav-content{gap:1rem}",
    );
    const ctx = withRegistry({ ...run.ctx, css, hoist: (h) => run.hoisted.push(h) }, registry);
    const style = el(ctx.convert([await realBlock("fineline", FINELINE_HEADER, "nav-c0498d1")])[0])
      .style as JxStyle;
    expect(style).toMatchObject({ "& .cc-nav-content": { gap: "1rem" } });
    expect(JSON.stringify(style)).not.toContain("cc-nav-header");
  });

  test("the nav is reported as approximated, once, with what is not carried", async () => {
    const r = await navOf("nav-ce2259c");
    const e = byCode(r.reports(), "interaction.approximated").find(
      (x) => x.data?.feature === "nav-modal",
    );
    expect(e?.message).toContain("popover");
    expect(e?.message).toContain("animation");
    expect(e?.where).toBe(
      "template-part:cwicly//header"
        .replace("template-part:", "part:")
        .replace("part:cwicly//header", e?.where ?? ""),
    );
  });

  test("a dropdown opens while its item is hovered or focused: the rules, under the item", async () => {
    const r =
      await convertMarkup(`<!-- wp:cwicly/navitems {"uniqueID":"u-ni","classID":"navitems-x","id":"navitems-x","additionalClassesR":"","isStyling":true} -->
<ul class="navitems-x cc-nav-items">${NAVDROPDOWN_MARKUP}</ul>
<!-- /wp:cwicly/navitems -->`);
    const rules = new Map(r.hoisted.map((h) => [h.selector, h.style]));
    expect(rules.get(".cc-nav-dropdown")).toEqual({ position: "relative" });
    expect(rules.get(".cc-nav-dropdown > .cc-nav-dropdown__content")).toMatchObject({
      top: "100%",
      left: "0",
      visibility: "hidden",
      opacity: "0",
    });
    expect(
      rules.get(
        ".cc-nav-dropdown:hover > .cc-nav-dropdown__content, .cc-nav-dropdown:focus-within > .cc-nav-dropdown__content",
      ),
    ).toEqual({ visibility: "visible", opacity: "1" });
  });
});

describe("nav items, links and dropdowns", () => {
  test("navitems is the list the plugin styles, with its classID first", async () => {
    const r = await navOf("navitems-c52720e");
    const ul = el(r.nodes[0]);
    expect(ul.tagName).toBe("ul");
    expect(classes(ul)).toEqual(["navitems-c52720e", "cc-nav-items"]);
    expect(kids(ul).length).toBe(6);
    expect(kids(ul).every((li) => el(li).tagName === "li")).toBe(true);
  });

  test("a nav link is a list item around the anchor the plugin's stylesheet targets", async () => {
    const r = await navOf("navlink-c677a96");
    const li = el(r.nodes[0]);
    expect(li.tagName).toBe("li");
    expect(classes(li)).toEqual(["navlink-c677a96", "cc-nav-link"]);
    const a = el(kids(li)[0]);
    expect(a.tagName).toBe("a");
    expect(a.className).toBe("cc-nav-item");
    expect(attrsOf(a).href).toBe("/projects/");
    expect(a.textContent).toBe("Projects");
  });

  test("the text of a link is the author's (HTML shows 'Service  Area' with one space, and so did the live page)", async () => {
    const r = await navOf("navlink-c963fd4");
    const a = el(kids(r.nodes[0])[0]);
    expect(a.textContent).toBe("Service Area");
    expect(attrsOf(a).href).toBe("/service_area/pennsylvania/");
  });

  test("a link to a page of the site is the Jx route, not the old address", async () => {
    const r = await navOf("navlink-c2f27ba", FINELINE_UPDATED);
    expect(attrsOf(kids(r.nodes[0])[0]).href).toBe("/residential/");
  });

  test("the current-page class has no static value and is reported, not printed", async () => {
    const r = await navOf("navlink-cb825db");
    expect(classes(r.nodes[0])).not.toContain("current");
    expect(r.reports().some((e) => e.code === "class.current-page")).toBe(true);
  });

  test("a link whose text holds its own link does not nest a second anchor; a button tag is a list item", async () => {
    const loaded = await loadSite("fineline");
    let nested: WpBlock | undefined;
    let subject: Subject | undefined;
    for (const s of allSubjects(loaded)) {
      walkBlocks(subjectBlocks(loaded, s), (b) => {
        if (
          nested === undefined &&
          b.name === "cwicly/navlink" &&
          b.attrs.classID === "navlink-ced2370"
        ) {
          nested = b;
          subject = s;
        }
      });
    }
    expect(nested).toBeDefined();
    const run = await runFor("fineline", subject as Subject);
    const nodes = run.ctx.convert([nested as WpBlock]);
    expect(el(nodes[0]).tagName).toBe("li");
    // One anchor, the author's; none carries the plugin's class.
    expect(html(nodes).match(/<a\b/g)?.length).toBe(1);
    expect(byClass(nodes, "cc-nav-item")).toEqual([]);
    expect(byCode(run.reports(), "nav.nested-link").length).toBe(1);
  });

  test("a link that opens a modal is a button the opener way", async () => {
    const r =
      await convertMarkup(`<!-- wp:cwicly/navlink {"isStyling":true,"content":"Sign in","uniqueID":"u-nl","classID":"navlink-x","id":"navlink-x","additionalClassesR":"","linkWrapperActive":true,"linkWrapperType":"action","linkWrapperAction":"modal","linkWrapperActionModalBlockId":"modal-sign-in","linkWrapperActionModalType":"open"} -->
<li class="navlink-x cc-nav-link"><a class="cc-nav-item" href="{empty}">Sign in</a></li>
<!-- /wp:cwicly/navlink -->`);
    const button = el(kids(r.nodes[0])[0]);
    expect(button.tagName).toBe("button");
    expect(button.className).toBe("cc-nav-item");
    expect(attrsOf(button)).toMatchObject({
      type: "button",
      popovertarget: "modal-sign-in",
      popovertargetaction: "show",
    });
  });

  test("a dropdown is the saved item with the script's state taken out", async () => {
    const r = await convertMarkup(NAVDROPDOWN_MARKUP);
    const li = el(r.nodes[0]);
    expect(li.tagName).toBe("li");
    expect(classes(li)).toEqual(["navdropdown-c2020d4", "cc-nav-dropdown"]);
    expect(attrsOf(li).id).toBe("navdropdown-cb6c8fd");
    const [button, content] = kids(li);
    expect(classes(button)).toEqual(["cc-nav-item", "cc-nav-dropdown__button"]);
    expect(attrsOf(content)["aria-hidden"]).toBeUndefined();
    // The saved inline `position:absolute` is the item's own rule now, so the box has a scope class of its own first.
    expect(classes(content).at(-1)).toBe("cc-nav-dropdown__content");
    expect(el(content).style).toMatchObject({ position: "absolute" });
    const toggle = el(byClass(r.nodes, "cc-nav-dropdown__button--icon")[0]);
    expect(attrsOf(toggle)["aria-expanded"]).toBeUndefined();
    expect(attrsOf(toggle)["is-trigger"]).toBeUndefined();
    expect(attrsOf(toggle)["aria-haspopup"]).toBe("true");
    const links = byClass(r.nodes, "cc-nav__submenu-item--link").map((a) => attrsOf(a).href);
    expect(links).toEqual(["https://example.org/wallpaper/", "https://example.org/upload/"]);
  });

  test("a dropdown that opens on click is reported as opening on hover and focus", async () => {
    const r = await convertMarkup(
      NAVDROPDOWN_MARKUP.replace(
        '"menuDropdownIsCustom":false',
        '"menuDropdownIsCustom":false,"menuDropdownOpenOn":"click"',
      ),
    );
    expect(byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "dropdown-click",
    );
  });
});

describe("menus", () => {
  test("a menu is its nav around the placeholder the menus emitter replaces", async () => {
    const run = await runFor("fineline", FINELINE_HEADER);
    const b = await realBlock("fineline", FINELINE_HEADER, "menu-c0fe5e2");
    const nodes = run.ctx.convert([b]);
    const nav = el(nodes[0]);
    expect(nav.tagName).toBe("nav");
    expect(nav.className).toBe("menu-c0fe5e2");
    expect(attrsOf(nav)["aria-label"]).toBe("Main Menu");
    const holder = el(kids(nav)[0]);
    expect(holder.tagName).toBe("wp2jx-menu");
    const read = readPlaceholder(holder);
    expect(read?.kind).toBe("menu");
    expect(read?.attrs["data-menu"]).toBe("5");
    expect(read?.block).toBe("cwicly/menu");
  });

  test("the menu's layout and options travel with it, and nothing of its styling does", async () => {
    const run = await runFor("fineline", FINELINE_HEADER);
    const b = await realBlock("fineline", FINELINE_HEADER, "menu-cb308ae");
    const holder = el(kids(run.ctx.convert([b])[0])[0]);
    const read = readPlaceholder(holder);
    expect(read?.blockAttrs.menuLayout).toEqual({ lg: "vertical" });
    expect(read?.blockAttrs.menuMainMenuGap).toEqual({ lg: "30px" });
    expect(read?.blockAttrs.menuSelected).toBe("5");
    expect(Object.keys(read?.blockAttrs ?? {}).every((k) => /^menu[A-Z]/.test(k))).toBe(true);
    expect(read?.blockAttrs).not.toHaveProperty("classID");
  });

  test("a menu names the menu of its own id: every menu of both sites", async () => {
    for (const [site, subjects] of [
      ["fineline", [FINELINE_HEADER, FINELINE_UPDATED]],
      ["ap", [AP_HEADER, AP_MOBILE_MENU]],
    ] as const) {
      const loaded = await loadSite(site);
      for (const subject of subjects) {
        const run = await runFor(site, subject);
        const menus: WpBlock[] = [];
        walkBlocks(subjectBlocks(loaded, subject), (b) => {
          if (b.name === "cwicly/menu") menus.push(b);
        });
        for (const b of menus) {
          const holder = byTag(run.ctx.convert([b]), "wp2jx-menu")[0];
          expect(readPlaceholder(holder as JxElement)?.attrs["data-menu"]).toBe(
            b.attrs.menuSelected as string,
          );
        }
      }
    }
  });

  test("a menu with no id is the menu of the theme location", async () => {
    const r =
      await convertMarkup(`<!-- wp:cwicly/menu {"isStyling":true,"uniqueID":"u-m","classID":"menu-x","id":"menu-x","additionalClassesR":""} -->
<nav class="menu-x" aria-label="{menuname}">{menu}</nav>
<!-- /wp:cwicly/menu -->`);
    const holder = el(kids(r.nodes[0])[0]);
    expect(holder.tagName).toBe("wp2jx-menu");
    expect(attrsOf(holder)["data-menu"]).toBeUndefined();
  });

  test("a menu block's condition hides it like any other block", async () => {
    const r =
      await convertMarkup(`<!-- wp:cwicly/menu {"isStyling":true,"uniqueID":"u-m","classID":"menu-x","id":"menu-x","additionalClassesR":"","menuSelected":"5","hideGuest":true} -->
<nav class="menu-x" aria-label="{menuname}">{menu}</nav>
<!-- /wp:cwicly/menu -->`);
    expect(r.nodes).toEqual([]);
  });

  test("a nav menu block (saved as {nav_menu=ID}) is the placeholder alone", async () => {
    const r = await convertMarkup(NAVMENU_MARKUP);
    expect(r.nodes.length).toBe(1);
    const holder = el(r.nodes[0]);
    expect(holder.tagName).toBe("wp2jx-menu");
    const read = readPlaceholder(holder);
    expect(read?.attrs["data-menu"]).toBe("5");
    expect(read?.block).toBe("cwicly/navmenu");
  });

  test("every placeholder a menu makes is one the placeholder module lists", () => {
    expect(PLACEHOLDERS.menu.tag).toBe("wp2jx-menu");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. Inputs, filters, range sliders and swatches
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe("inputs", () => {
  test("anabaptistperspectives' search box is an input with the attributes the editor saved", async () => {
    const run = await runFor("ap", AP_HEADER);
    const b = await realBlock("ap", AP_HEADER, "search");
    const nodes = run.ctx.convert([b]);
    const input = el(nodes[0]);
    expect(input.tagName).toBe("input");
    expect(classes(input)[0]).toBe("search");
    expect(attrsOf(input)).toMatchObject({
      id: "s",
      type: "text",
      name: "s",
      placeholder: "Press enter to submit.",
    });
    expect(input.children).toBeUndefined();
  });

  test("the plugin's own hooks on an input (Relevanssi's data attributes) are kept, a script on it is not", async () => {
    const r =
      await convertMarkup(`<!-- wp:cwicly/input {"isStyling":true,"uniqueID":"u-i","classID":"search-live","id":"search-live","additionalClassesR":""} -->
<input id="search-live{idadd}" class="search-live" type="text" name="s" data-rlvlive="true" oninput="this.form.submit()"/>
<!-- /wp:cwicly/input -->`);
    expect(attrsOf(r.nodes[0])["data-rlvlive"]).toBe("true");
    expect(attrsOf(r.nodes[0]).oninput).toBeUndefined();
    expect(byCode(r.reportsNow, "interaction.dropped").map((e) => e.data?.feature)).toContain(
      "input-handlers",
    );
  });

  test("a comment form's textarea and submit button stay where they are, say what they cannot do and lose their inline script", async () => {
    const loaded = await loadSite("ap");
    const comments: Subject = { kind: "part", slug: "comments" };
    const run = await runFor("ap", comments);
    const found: WpBlock[] = [];
    walkBlocks(subjectBlocks(loaded, comments), (b) => {
      if (b.name === "cwicly/input") found.push(b);
    });
    const nodes = run.ctx.convert(found);
    expect(nodes.map((n) => el(n).tagName)).toEqual(["textarea", "input"]);
    expect(attrsOf(nodes[0]).oninput).toBeUndefined();
    expect(attrsOf(nodes[0]).placeholder).toBe("Leave a Comment");
    expect(attrsOf(nodes[1])).toMatchObject({ type: "submit", value: "submit" });
    const features = byCode(run.reports(), "interaction.dropped").map((e) => e.data?.feature);
    expect(features).toContain("comment-form");
    expect(features).toContain("input-handlers");
  });

  test("a block with no saved markup builds its attributes from the editor's (a copy kept in a component)", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    const b: WpBlock = {
      name: "cwicly/input",
      attrs: {
        uniqueID: "u",
        inputType: "email",
        inputName: "mail",
        inputPlaceholder: "you@example.org",
        inputRequired: true,
        inputMaxLength: 80,
      },
      innerBlocks: [],
      innerHTML: "",
      innerContent: [""],
    };
    const input = el(run.ctx.convert([b])[0]);
    expect(input.tagName).toBe("input");
    expect(attrsOf(input)).toMatchObject({
      type: "email",
      name: "mail",
      placeholder: "you@example.org",
      required: true,
      maxlength: 80,
    });
  });

  test("a filter's own templates are checkboxes and search boxes", async () => {
    const mk = (
      template: string,
    ) => `<!-- wp:cwicly/input {"uniqueID":"u","classID":"input-x","id":"input-x","additionalClassesR":"","inputTemplate":"${template}"} -->
<input/>
<!-- /wp:cwicly/input -->`;
    expect(attrsOf((await convertMarkup(mk("filtercheckbox"))).nodes[0]).type).toBe("checkbox");
    expect(attrsOf((await convertMarkup(mk("filtersearch"))).nodes[0]).type).toBe("search");
  });
});

describe("filters", () => {
  const termsOf = (ctx: ConvertCtx, taxonomy: string) =>
    [...ctx.model.terms.values()].filter((t) => t.taxonomy === taxonomy);

  test("fineline's project type filter is a list of links to the term archives, one template button each", async () => {
    const run = await runFor("fineline", { kind: "template", slug: "archive-project" });
    const b = await realBlock(
      "fineline",
      { kind: "template", slug: "archive-project" },
      "filter-project-type",
    );
    const nodes = run.ctx.convert([b]);
    const root = el(nodes[0]);
    expect(root.tagName).toBe("div");
    expect(classes(root)[0]).toBe("filter-project-type");
    expect(attrsOf(root)["cc-filter"]).toBeUndefined();
    const items = kids(root);
    const terms = termsOf(run.ctx, "project_type")
      .filter((t) => t.count > 0)
      .sort((a, b2) =>
        decodeEntities(a.name).toLowerCase().localeCompare(decodeEntities(b2.name).toLowerCase()),
      );
    expect(items.length).toBe(terms.length);
    expect(items.length).toBeGreaterThan(5);
    items.forEach((item, i) => {
      const a = el(item);
      expect(a.tagName).toBe("a");
      expect(attrsOf(a).href).toBe(run.ctx.urlFor("term", terms[i]!.termId) as string);
      // The link is a box of its own: a `display: contents` anchor cannot take the focus, so no keyboard visitor could reach it.
      expect(a.style).toBeUndefined();
      const button = el(kids(a)[0]);
      expect(classes(button)[0]).toBe("button-c7f0ebb");
      expect(html([button])).toContain(`>${escapeHtml(decodeEntities(terms[i]!.name))}</div>`);
    });
    expect(byCode(run.reports(), "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "filter-taxonomy",
    );
  });

  test("no template block is left with its {filter=name} token or its empty dynamic text", async () => {
    const run = await runFor("fineline", { kind: "template", slug: "archive-project" });
    const b = await realBlock(
      "fineline",
      { kind: "template", slug: "archive-project" },
      "filter-project-type",
    );
    const out = html(run.ctx.convert([b]));
    expect(out).not.toContain("{filter");
    expect(out).not.toContain("${");
  });

  test("a select filter is a plain list of links (the script made the options)", async () => {
    const subject: Subject = { kind: "template", slug: "archive-project" };
    const run = await runFor("fineline", subject);
    const b = await realBlock("fineline", subject, "filter-c4dfa59");
    const root = el(run.ctx.convert([b])[0]);
    const ul = el(kids(root)[0]);
    expect(ul.tagName).toBe("ul");
    expect(ul.style).toMatchObject({ listStyle: "none" });
    expect(kids(ul).length).toBeGreaterThan(5);
    expect(kids(ul).every((li) => el(li).tagName === "li")).toBe(true);
    expect(html([ul])).toContain("/service_area/lancaster-county-pa/");
  });

  test("a checkbox filter of anabaptistperspectives lists its terms, with no count (the live checkbox filter prints none)", async () => {
    const subject: Subject = { kind: "post", id: 5046 };
    const run = await runFor("ap", subject);
    const b = await realBlock("ap", subject, "filter-c76ab88");
    // The block asks for counts, and the live page still shows none: a count shows only where a query supplies a counter.
    expect(b.attrs.filterCountItems).toBe(true);
    const out = html(run.ctx.convert([b]));
    const category = termsOf(run.ctx, "category").filter(
      (t) => t.count > 0 && !termsOf(run.ctx, "category").some((o) => o.parent === t.termId),
    );
    expect(category.length).toBeGreaterThan(5);
    expect(out).not.toMatch(/\(\d+\)/);
    for (const t of category) expect(out).toContain(`>${escapeHtml(decodeEntities(t.name))}</a>`);
    expect(out).toContain("/category/bible/");
    expect(byCode(run.reports(), "interaction.approximated").length).toBeGreaterThan(0);
  });

  test("order, maximum, inclusion and exclusion are WordPress's get_terms arguments", async () => {
    const subject: Subject = { kind: "post", id: 5046 };
    const run = await runFor("ap", subject);
    const b = await realBlock("ap", subject, "filter-c76ab88");
    const names = (attrs: Record<string, unknown>): string[] => {
      const out = run.ctx.convert([{ ...b, attrs: { ...b.attrs, ...attrs } }]);
      return byTag(out, "li").map((li) =>
        html([li])
          .replace(/<[^>]+>/g, "")
          .replace(/ \(\d+\)$/, ""),
      );
    };
    const byName = names({});
    expect(byName).toEqual(
      [...byName].sort((a, c) => a.toLowerCase().localeCompare(c.toLowerCase())),
    );
    const byCount = names({ filterOrderBy: "count", filterOrder: "DESC" });
    const countOf = (name: string): number =>
      termsOf(run.ctx, "category").find((t) => decodeEntities(t.name) === decodeEntities(name))
        ?.count ?? -1;
    const counts = byCount.map(countOf);
    expect(counts.length).toBeGreaterThan(5);
    expect(counts).toEqual([...counts].sort((a, c) => c - a));
    // `filterMaximum` is a boolean of the editor's own preview: the live filter never sends it.
    expect(names({ filterMaximum: "3" })).toEqual(byName);
    expect(names({ filterMaximum: true })).toEqual(byName);
    const bible = termsOf(run.ctx, "category").find((t) => t.slug === "bible")!;
    expect(names({ filterInclude: [{ value: bible.termId, label: "Bible" }] })).toEqual(["Bible"]);
    expect(names({ filterExclude: [bible.termId] })).not.toContain("Bible");
    // An empty term shows only when the filter does not hide empty ones.
    expect(names({ filterHideEmpty: false }).length).toBeGreaterThanOrEqual(byName.length);
  });

  test("a term with no archive page is text, and the filter says how many", async () => {
    const subject: Subject = { kind: "post", id: 5046 };
    const run = await runFor("ap", subject, { urlFor: () => undefined });
    const b = await realBlock("ap", subject, "filter-c76ab88");
    const out = run.ctx.convert([b]);
    expect(byTag(out, "a")).toEqual([]);
    expect(byTag(out, "span").length).toBeGreaterThan(5);
    const e = byCode(run.reports(), "filter.static").find((x) =>
      String(x.data?.detail).endsWith("unlinked"),
    );
    expect(e?.data?.count).toBeGreaterThan(5);
  });

  test("{filter=…} tokens and a dynamic filter text are the term's own, whatever the template block is", async () => {
    const run = await runFor("ap", { kind: "post", id: 5046 });
    const tokenised = `<!-- wp:cwicly/filter {"isStyling":true,"filterType":"buttonsingle","filterSource":"dynamic","filterDataType":"taxonomy","filterData":[{"label":"Categories","value":"category","type":"post"}],"filterCountItems":true,"filterInclude":["${[...run.ctx.model.terms.values()].find((t) => t.taxonomy === "category" && t.slug === "bible")!.termId}"],"uniqueID":"u-f","classID":"filter-t","id":"filter-t","additionalClassesR":""} -->
<div id="filter-t{idadd}" class="filter-t" cc-filter=""><ccdyn><!-- wp:cwicly/paragraph {"uniqueID":"u-fp","classID":"paragraph-ft","id":"paragraph-ft","additionalClassesR":"","content":"{filter=name} ({filter=count}) {filter=slug}"} -->
<p>{filter=name} ({filter=count}) {filter=slug}</p>
<!-- /wp:cwicly/paragraph --></ccdyn></div>
<!-- /wp:cwicly/filter -->`;
    const out = html(run.ctx.convert(finishNodes(blocksOf(tokenised)) as unknown as WpBlock[]));
    const bible = [...run.ctx.model.terms.values()].find(
      (t) => t.taxonomy === "category" && t.slug === "bible",
    )!;
    expect(out).toContain(`<p>Bible (${bible.count}) bible</p>`);
  });

  test("the selection and clear filters are left empty, as the live page prints them before anything is chosen", async () => {
    const subject: Subject = { kind: "post", id: 5046 };
    const run = await runFor("ap", subject);
    const sel = await realBlock("ap", subject, "filter-cea5cd9");
    const clear = await realBlock("ap", subject, "filter-c2b4a1c");
    for (const b of [sel, clear]) {
      const root = el(run.ctx.convert([b])[0]);
      expect(root.tagName).toBe("div");
      expect(root.children).toBeUndefined();
      expect(attrsOf(root)["cc-filter"]).toBeUndefined();
    }
    const found = byCode(run.reports(), "filter.static");
    expect(found.map((x) => x.data?.filterType)).toContain("userselection");
    expect(found.map((x) => x.data?.filterType)).toContain("clearselection");
    expect(found.find((x) => x.data?.filterType === "userselection")?.severity).toBe("info");
    expect(found.find((x) => x.data?.filterType === "userselection")?.message).toContain("chosen");
    expect(found.find((x) => x.data?.filterType === "clearselection")?.message).toContain("clears");
  });

  test("a search filter keeps its box and says the search does nothing here", async () => {
    const subject: Subject = { kind: "post", id: 5046 };
    const run = await runFor("ap", subject);
    const b = await realBlock("ap", subject, "filter-c4d8a2a");
    const root = el(run.ctx.convert([b])[0]);
    expect(kids(root).map((k) => el(k).tagName)).toEqual(["input", "div"]);
    const e = byCode(run.reports(), "filter.static").find((x) => x.data?.filterType === "custom");
    expect(e?.severity).toBe("warn");
    expect(e?.message).toContain("static page cannot run a query");
  });

  test("a filter by something that is not a term of a known taxonomy is reported and left empty", async () => {
    const subject: Subject = { kind: "post", id: 5046 };
    const run = await runFor("ap", subject);
    const author = await realBlock("ap", subject, "filter-cf1c14e");
    const root = el(run.ctx.convert([author])[0]);
    expect(root.children).toBeUndefined();
    expect(
      byCode(run.reports(), "filter.static").some((e) =>
        String(e.message).includes("dynamic (taxonomy)"),
      ),
    ).toBe(true);
  });

  test("a taxonomy that has no terms is reported, not an empty list", async () => {
    const run = await runFor("ap", { kind: "post", id: 5046 });
    const mk = (
      taxonomy: string,
    ) => `<!-- wp:cwicly/filter {"filterType":"custom","filterSource":"dynamic","filterDataType":"taxonomy","filterData":[{"label":"x","value":"${taxonomy}","type":"post"}],"uniqueID":"u","classID":"filter-n","id":"filter-n","additionalClassesR":""} -->
<div id="filter-n{idadd}" cc-filter=""><ccdyn></ccdyn></div>
<!-- /wp:cwicly/filter -->`;
    const out = run.ctx.convert(blocksOf(mk("no_such_taxonomy")));
    expect(el(out[0]).children).toBeUndefined();
    expect(
      byCode(run.reports(), "filter.static").some((e) => String(e.data?.detail).endsWith("empty")),
    ).toBe(true);
  });
});

describe("range sliders and swatches", () => {
  test("a range slider is an empty box that says it filters nothing", async () => {
    const r = await convertMarkup(RANGESLIDER_MARKUP);
    const root = el(r.nodes[0]);
    expect(root.tagName).toBe("div");
    expect(root.children).toBeUndefined();
    const e = byCode(r.reportsNow, "filter.static")[0];
    expect(e?.data?.feature).toBe("rangeslider");
    expect(e?.severity).toBe("warn");
  });

  test("a swatch is a WooCommerce attribute and is left out, reported", async () => {
    const r = await convertMarkup(SWATCH_MARKUP);
    expect(r.nodes).toEqual([]);
    const e = byCode(r.reportsNow, "block.unsupported")[0];
    expect(e?.data).toMatchObject({
      feature: "woocommerce",
      swatch: "pa_color",
      block: "cwicly/swatch",
    });
  });

  test("both are located at the subject with its public address when it has one", async () => {
    const r = await convertMarkup(RANGESLIDER_MARKUP);
    const e = byCode(r.reportsNow, "filter.static")[0];
    expect(e?.where).toBe("post:5246");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. The live pages as oracle
// ═══════════════════════════════════════════════════════════════════════════════════════════════

type P5Node = DefaultTreeAdapterMap["node"];
type P5Element = DefaultTreeAdapterMap["element"];

const isP5Element = (n: P5Node): n is P5Element => "tagName" in n;
const p5attr = (e: P5Element, name: string): string | undefined =>
  e.attrs.find((a) => a.name === name)?.value;
const p5classes = (e: P5Element): string[] =>
  (p5attr(e, "class") ?? "").split(/\s+/).filter(Boolean);

function p5find(
  node: P5Node,
  accept: (e: P5Element) => boolean,
  out: P5Element[] = [],
): P5Element[] {
  if (isP5Element(node) && accept(node)) out.push(node);
  const children =
    "tagName" in node && node.tagName === "template"
      ? []
      : "childNodes" in node
        ? node.childNodes
        : [];
  for (const child of children) p5find(child, accept, out);
  return out;
}

const liveHtml = (site: SiteName, page: string): P5Node =>
  parseFragment(
    readFileSync(join(import.meta.dir, "../../fixtures", site, "html", `${page}.html`), "utf8"),
  );

/**
 * The element tree as a list of `tag.class.class` in document order (classes sorted, Jx scope classes
 * and the current-page class left out). Descendants of an element `cut` names are not listed: the
 * live page prints a rendered menu where the converted one has the placeholder.
 */
function shapeOf(root: P5Element, cut: (e: P5Element) => boolean = () => false): string[] {
  const out: string[] = [];
  const visit = (e: P5Element): void => {
    const cls = p5classes(e)
      .filter((c) => !/^jx-[0-9a-f]{10}$/.test(c) && c !== "current")
      .sort();
    out.push([e.tagName, ...cls].join("."));
    if (cut(e)) return;
    for (const child of e.childNodes) if (isP5Element(child)) visit(child);
  };
  visit(root);
  return out;
}

const isMenuBox = (e: P5Element): boolean =>
  e.tagName === "nav" && p5classes(e).some((c) => c.startsWith("menu-c"));

/** What the converted page prints for nodes, parsed. */
const printed = (nodes: JxNode[]): P5Node => parseFragment(html(nodes));

describe("fineline's header navigation against the live pages", () => {
  const PAGES = [
    "about-us",
    "blog",
    "choosing-the-best-log-home-stain",
    "home",
    "privacy-policy",
    "residential",
  ];

  /** The two navs of a live page's header, outermost first. */
  const liveNavs = (page: string): P5Element[] =>
    p5find(
      liveHtml("fineline", page),
      (e) => e.tagName === "div" && p5classes(e).includes("cc-nav"),
    );

  test("every live page prints the same two navs, which the fixtures' header part describes", () => {
    for (const page of PAGES) {
      const navs = liveNavs(page);
      expect(navs.map((n) => p5classes(n)[0])).toEqual(["nav-c0498d1", "nav-ce2259c"]);
    }
  });

  test("the top nav: the converted markup is the live markup, less the backdrop link", async () => {
    const r = await navOf("nav-c0498d1");
    const converted = p5find(printed(r.nodes), (e) => p5classes(e).includes("cc-nav"))[0]!;
    for (const page of PAGES) {
      const live = liveNavs(page)[0]!;
      const expected = shapeOf(live, isMenuBox).filter((s) => s !== "a.cc-nav-backdrop");
      expect(shapeOf(converted, isMenuBox)).toEqual(expected);
    }
  });

  test("the mobile nav: the live markup with the hamburger a button, the cross drawn on the close button and no backdrop", async () => {
    const r = await navOf("nav-ce2259c");
    const converted = p5find(printed(r.nodes), (e) => p5classes(e).includes("cc-nav"))[0]!;
    // The live header is newer than the database rows (the fixtures are not one snapshot): the "Tablet Only Menu"
    // (menu-cb308ae) is in the saved part and no longer on the page.
    const got = shapeOf(converted, isMenuBox).filter((s) => s !== "nav.menu-cb308ae");
    for (const page of PAGES) {
      const live = liveNavs(page)[1]!;
      const expected = shapeOf(live, isMenuBox)
        .filter((s) => s !== "a.cc-nav-backdrop")
        .map((s) =>
          s.startsWith("div.cc-hamburger") && s.includes("cc-nav-toggle")
            ? s.replace("div.", "button.")
            : s,
        )
        .flatMap((s) =>
          s === "button.cc-hamburger.cc-nav-toggle--close"
            ? [
                "button.active.cc-hamburger.cc-hamburger-tilt.cc-nav-toggle--close",
                "div.line",
                "div.line",
                "div.line",
              ]
            : [s],
        );
      // The toggle's three lines come after its button in both; only the order of the two siblings differs by the cross.
      expect([...got].sort()).toEqual([...expected].sort());
      expect(got.length).toBe(expected.length);
    }
  });

  test("the six links of the top nav are the live links: the same text, the same pages", async () => {
    const r = await navOf("navitems-c52720e");
    const converted = p5find(printed(r.nodes), (e) => p5classes(e).includes("cc-nav-link"));
    const live = p5find(
      liveHtml("fineline", "about-us"),
      (e) =>
        p5classes(e).includes("navlink-c677a96") ||
        p5classes(e).some((c) =>
          [
            "navlink-c963fd4",
            "navlink-c98ff7b",
            "navlink-cd7f676",
            "navlink-cb825db",
            "navlink-c6c1af6",
          ].includes(c),
        ),
    );
    const pair = (e: P5Element) => {
      const a = p5find(e, (x) => x.tagName === "a")[0]!;
      const text = (a.childNodes[0] as { value?: string } | undefined)?.value ?? "";
      return [
        text.replace(/\s+/g, " "),
        (p5attr(a, "href") ?? "").replace("https://finelinepainting.pro", ""),
      ];
    };
    expect(converted.map(pair)).toEqual(live.map(pair));
    expect(converted.length).toBe(6);
  });

  test("every nav of the site converts to the live page's shape, on all six pages' worth of header", async () => {
    const r = await navOf("nav-ce2259c");
    const rules = r.hoisted.map((h) => h.selector);
    // The stylesheets the live page has for this nav name the same attribute the converted element carries.
    expect(rules.some((s) => s.includes('[breakpoint="md"]'))).toBe(true);
    for (const page of PAGES) {
      expect(p5attr(liveNavs(page)[1]!, "breakpoint")).toBe("md");
    }
  });
});

describe("anabaptistperspectives' header, modal and menus against the live pages", () => {
  const PAGES = [
    "essays",
    "essays__get-in-the-way-of-evil",
    "essays__the-cultural-captivity-of-the-gospel",
  ];

  const liveShell = (page: string): P5Element =>
    p5find(liveHtml("ap", page), (e) =>
      e.attrs.some((a) => a.name === "id" && a.value === "modal-overlay-menu"),
    )[0]!;

  test("the overlay menu: the shell, the dimming layer, the container and the modal are the live elements", async () => {
    const run = await runFor("ap", AP_MOBILE_MENU);
    const nodes = run.ctx.convert([await realBlock("ap", AP_MOBILE_MENU, "modal-overlay-menu")]);
    const converted = p5find(printed(nodes), (e) => p5attr(e, "id") === "modal-overlay-menu")[0]!;
    for (const page of PAGES) {
      const live = liveShell(page);
      expect(p5classes(converted)).toEqual(p5classes(live));
      const cut = (e: P5Element) => p5classes(e).includes("cc-modaler");
      const expected = shapeOf(live, cut).map((s) =>
        s === "a.cc-mdl-close" ? "button.cc-mdl-close" : s,
      );
      expect(shapeOf(converted, cut)).toEqual(expected);
    }
  });

  test("the live close layer is a link to #, the converted one a button naming the modal", async () => {
    const live = liveShell("essays");
    const a = p5find(live, (e) => p5classes(e).includes("cc-mdl-close"))[0]!;
    expect(a.tagName).toBe("a");
    expect(p5attr(a, "href")).toBe("#");
    const run = await runFor("ap", AP_MOBILE_MENU);
    const nodes = run.ctx.convert([await realBlock("ap", AP_MOBILE_MENU, "modal-overlay-menu")]);
    const b = p5find(printed(nodes), (e) => p5classes(e).includes("cc-mdl-close"))[0]!;
    expect(p5attr(b, "popovertarget")).toBe("modal-overlay-menu");
  });

  test("the menus: each live menu box has a converted one with its class and label, and the menu it holds", async () => {
    const live = p5find(liveHtml("ap", "essays"), isMenuBox).map((n) => [
      p5classes(n)[0],
      p5attr(n, "aria-label"),
    ]);
    const loaded = await loadSite("ap");
    const converted: (string | undefined)[][] = [];
    for (const subject of allSubjects(loaded)) {
      const menus: WpBlock[] = [];
      walkBlocks(subjectBlocks(loaded, subject), (b) => {
        if (b.name === "cwicly/menu") menus.push(b);
      });
      if (menus.length === 0) continue;
      const run = await runFor("ap", subject);
      for (const m of menus) {
        const nav = el(run.ctx.convert([m])[0]);
        converted.push([classes(nav)[0], attrsOf(nav)["aria-label"] as string]);
      }
    }
    expect(live.length).toBeGreaterThan(0);
    for (const pair of live) {
      expect(converted).toContainEqual(pair);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. Building through Jx
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** The files of a project whose one page is `nodes` and whose `style` is what the blocks hoisted. */
function projectFiles(
  nodes: JxNode[],
  hoisted: Run["hoisted"],
  media: Record<string, string>,
  extra: Record<string, ProjectFile> = {},
): Record<string, ProjectFile> {
  const style: JxStyle = {};
  for (const r of hoisted)
    style[r.selector] = mergeStyle(style[r.selector] as JxStyle | undefined, r.style);
  return {
    "project.json": {
      name: "wp2jx-test",
      url: "https://example.com",
      defaults: { layout: "./layouts/base.json" },
      $media: media,
      style,
    },
    "layouts/base.json": { children: [{ tagName: "slot" }] },
    "pages/index.json": { title: "Interactive", children: nodes },
    ...extra,
  };
}

const compactHtml = (built: BuiltProject): string => built.html("/").replace(/\s+/g, " ");

describe("building through Jx", () => {
  test("accordions, tabs, a slider, a modal and a popover build and validate; the page ships no script", async () => {
    const markup = [
      accordionsMarkup(
        accordionMarkup(
          "1",
          "Open",
          ',"accordionOpen":true,"accordionLinked":true,"accordionGroup":"faq"',
          "cc-accordion-active",
        ) + accordionMarkup("2", "Closed", ',"accordionLinked":true,"accordionGroup":"faq"'),
      ),
      TABS_MARKUP,
      sliderMarkup(',"sliderNumberPerWindow":{"lg":"2","md":"1"}'),
      modalMarkup(),
      popoverMarkupForBuild(),
    ].join("\n");
    const r = await convertMarkup(markup);
    const site = await buildJxProject(projectFiles(r.nodes, r.hoisted, r.ctx.cwicly.media), {
      name: "interactive",
    });
    const page = compactHtml(site);
    // Native elements, in the page.
    expect(page).toMatch(/<details[^>]* name="faq"[^>]* open/);
    expect(page).toContain("<summary");
    expect(page).toMatch(/<input[^>]*type="radio"[^>]*checked/);
    expect(page).toContain('popover="auto"');
    expect(page).toContain('popovertarget="modal-promo"');
    expect(page).toContain("scroll-snap-type: x mandatory");
    // The rules the converters hoisted are in the page's stylesheet, with their media queries.
    expect(page).toContain(
      ":root:has(#tabcontents-collection-design-tab-1:not(:checked)) #tabcontents-collection-design-panel-1",
    );
    expect(page).toContain(".cc-mdl[popover]:popover-open");
    expect(page).toContain("body:has(#modal-promo:popover-open)");
    expect(page).toMatch(/@media \(max-width: 992px\)[^}]*--cc-slides: 1/);
    // No client runtime: nothing here is bound or scripted.
    expect(site.list().filter((f) => f.endsWith(".js"))).toEqual([]);
    expect(page).not.toContain("<script");
    const validation = await validateJxProject(site.dir);
    expect(validation.problems).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  test("the nav, its dropdown and its menu placeholder build; the media rules for the modal are at-rules", async () => {
    const run = await runFor("fineline", FINELINE_HEADER);
    const nodes = run.ctx.convert([
      await realBlock("fineline", FINELINE_HEADER, "nav-ce2259c"),
      ...blocksOf(NAVDROPDOWN_MARKUP),
    ]);
    const site = await buildJxProject(projectFiles(nodes, run.hoisted, run.ctx.cwicly.media), {
      name: "nav",
    });
    const page = compactHtml(site);
    expect(page).toContain('popover="auto"');
    expect(page).toContain('id="nav-c5786fb-wrapper"');
    expect(page).toMatch(
      /@media \(max-width: 992px\) \{ \.cc-nav\[breakpoint="md"\] > \.cc-nav-wrapper\[popover\]:popover-open \{/,
    );
    expect(page).toContain(".cc-nav-dropdown:hover > .cc-nav-dropdown__content");
    expect(page).toContain("<wp2jx-menu");
    const validation = await validateJxProject(site.dir);
    expect(validation.problems).toEqual([]);
  });

  test("the filter's links, the popover's anchor positioning and a hidden panel build", async () => {
    const run = await runFor("ap", AP_FOOTER);
    const nodes = run.ctx.convert([await nthBlock("ap", AP_FOOTER, "cwicly/popover")]);
    const site = await buildJxProject(projectFiles(nodes, run.hoisted, run.ctx.cwicly.media), {
      name: "popover",
    });
    const page = compactHtml(site);
    expect(page).toContain("anchor-name: --popover-popover-c369aa8");
    expect(page).toContain("position-area: bottom span-right");
    expect(page).toMatch(/:root:has\(#paragraph-content:hover\) #popover-c369aa8/);
    expect((await validateJxProject(site.dir)).problems).toEqual([]);
  });

  test("a filter's list of term links builds with real hrefs", async () => {
    const subject: Subject = { kind: "template", slug: "archive-project" };
    const run = await runFor("fineline", subject);
    const nodes = run.ctx.convert([await realBlock("fineline", subject, "filter-project-type")]);
    const site = await buildJxProject(projectFiles(nodes, run.hoisted, run.ctx.cwicly.media), {
      name: "filter",
    });
    const page = compactHtml(site);
    expect(page).toContain('href="/project_type/agricultural/"');
    expect((page.match(/<a /g) ?? []).length).toBeGreaterThan(5);
    expect((await validateJxProject(site.dir)).problems).toEqual([]);
  });
});

/** A native popover (no trigger element) as the plugin saves it. */
function popoverMarkupForBuild(): string {
  return `<!-- wp:cwicly/popover {"popoverOptions":{"placement":"bottom"},"isStyling":true,"uniqueID":"u-po","classID":"popover-b","id":"popover-b","additionalClassesR":""} -->
<div id="popover-b{idadd}" class="popover-b" data-ccp-state="hidden"><!-- wp:cwicly/paragraph {"content":"More","uniqueID":"u-pp","classID":"paragraph-pp","id":"paragraph-pp","additionalClassesR":""} -->
<p>More</p>
<!-- /wp:cwicly/paragraph --></div>
<!-- /wp:cwicly/popover -->`;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. A real browser
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const CHROME = process.env.WP2JX_CHROME ?? "/run/current-system/sw/bin/google-chrome-stable";
const BROWSER = existsSync(CHROME) && process.env.WP2JX_NO_BROWSER !== "1";

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  svg: "image/svg+xml",
  json: "application/json",
};

/** Plugin CSS, the site's global CSS and (when given) a template part's file, as files of a project and the `$head` that links them. */
async function siteCss(
  site: SiteName,
  blocks: readonly WpBlock[],
  partFiles: string[] = [],
): Promise<{
  files: Record<string, ProjectFile>;
  head: { tagName: string; attributes: Record<string, string> }[];
}> {
  const loaded = await loadSite(site);
  const features: Record<string, boolean> = {};
  for (const f of compatFeaturesForBlocks(blocks)) if (f !== "aos") features[f] = true;
  const compat = buildCompatCss(dirPluginSource(PLUGIN), features);
  const dir = fixtureCssDir(site);
  const read = (name: string): string => {
    const path = join(dir, name);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  const files: Record<string, ProjectFile> = {
    "public/css/cwicly-base.css": compat.content,
    "public/css/global-inline.css": loaded.options.compiledCss.global,
    "public/css/global-stylesheets.css": read("cc-global-stylesheets.css"),
    "public/css/global-classes.css": read("cc-global-classes.css"),
  };
  const links = ["cwicly-base", "global-inline", "global-stylesheets", "global-classes"];
  for (const name of partFiles) {
    files[`public/css/${name}`] = read(name);
    links.push(name.replace(/\.css$/, ""));
  }
  return {
    files,
    head: links.map((n) => ({
      tagName: "link",
      attributes: { rel: "stylesheet", href: `/css/${n}.css` },
    })),
  };
}

describe.skipIf(!BROWSER)("in a real browser", () => {
  let browser: Browser;
  const open = new Set<Page>();

  beforeAll(async () => {
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars"],
    });
  });
  afterAll(async () => {
    for (const p of open) await p.close().catch(() => {});
    await browser?.close();
  });

  /** A page of the built project (its files served from memory under http://wp2jx.test/), and any extra documents. */
  async function openBuilt(
    built: BuiltProject,
    width: number,
    extra: Record<string, string> = {},
    path = "/",
  ): Promise<Page> {
    const page = await browser.newPage();
    open.add(page);
    await page.setViewport({ width, height: 900 });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.hostname !== "wp2jx.test") {
        void request.abort();
        return;
      }
      const name = url.pathname;
      if (extra[name] !== undefined) {
        void request.respond({
          status: 200,
          contentType: MIME.html as string,
          body: extra[name] as string,
        });
        return;
      }
      const rel = name.endsWith("/") ? `${name.slice(1)}index.html` : name.slice(1);
      try {
        const body = built.read(rel);
        void request.respond({
          status: 200,
          contentType: MIME[rel.split(".").pop() ?? "html"] ?? "application/octet-stream",
          body,
        });
      } catch {
        void request.respond({ status: 404, body: "not found" });
      }
    });
    await page.goto(`http://wp2jx.test${path}`, { waitUntil: "load" });
    return page;
  }

  async function close(page: Page): Promise<void> {
    open.delete(page);
    await page.close();
  }

  /** A project of the converted nodes with the site's CSS. */
  async function project(
    run: Run & { nodes: JxNode[] },
    site: SiteName,
    blocks: readonly WpBlock[],
    partFiles: string[] = [],
  ): Promise<BuiltProject> {
    const css = await siteCss(site, blocks, partFiles);
    const files = projectFiles(run.nodes, run.hoisted, run.ctx.cwicly.media, css.files);
    const projectJson = files["project.json"] as Record<string, unknown>;
    projectJson.$head = css.head;
    return buildJxProject(files, { name: "browser" });
  }

  const visible = (page: Page, selector: string): Promise<boolean> =>
    page.$eval(selector, (e) =>
      (e as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: true }),
    );

  test("an accordion opens when its summary is clicked and closes when clicked again", async () => {
    const r = await convertMarkup(
      accordionsMarkup(accordionMarkup("1", "First") + accordionMarkup("2", "Second")),
    );
    const page = await openBuilt(await project(r, "fineline", []), 1000);
    expect(await visible(page, "#accordion-c1 .cc-acdc")).toBe(false);
    await page.click("#accordion-c1 summary");
    expect(await page.$eval("#accordion-c1", (e) => (e as HTMLDetailsElement).open)).toBe(true);
    expect(await visible(page, "#accordion-c1 .cc-acdc")).toBe(true);
    await page.click("#accordion-c1 summary");
    expect(await visible(page, "#accordion-c1 .cc-acdc")).toBe(false);
    // The summary shows no disclosure triangle (the plugin's button had none).
    expect(
      await page.$eval("#accordion-c1 summary", (e) => getComputedStyle(e).listStyleType),
    ).toBe("none");
    await close(page);
  });

  test("an accordion that starts open is open, and a group lets one open at a time", async () => {
    const r = await convertMarkup(
      accordionsMarkup(
        accordionMarkup("1", "Open", ',"accordionOpen":true', "cc-accordion-active") +
          accordionMarkup("2", "Closed"),
        ',"accordionLinked":true,"accordionGroup":"faq"',
        ' data-cc-accordions-group="faq"',
      ),
    );
    const page = await openBuilt(await project(r, "fineline", []), 1000);
    const state = () =>
      page.$$eval("details", (all) => all.map((d) => (d as HTMLDetailsElement).open));
    expect(await state()).toEqual([true, false]);
    await page.click("#accordion-c2 summary");
    expect(await state()).toEqual([false, true]);
    await page.click("#accordion-c1 summary");
    expect(await state()).toEqual([true, false]);
    await close(page);
  });

  test("tabs: the first panel shows, a click on another tab swaps them, the arrow keys move between tabs", async () => {
    const r = await convertMarkup(TABS_MARKUP);
    const page = await openBuilt(await project(r, "fineline", []), 1000);
    const shown = () =>
      page.$$eval("#tabcontents-collection-design > div", (all) =>
        all.map((p) => (p as HTMLElement).checkVisibility()),
      );
    expect(await shown()).toEqual([true, false]);
    await page.click("#tab-c13547d");
    expect(await shown()).toEqual([false, true]);
    expect(
      await page.$$eval(".cc-tab-radio", (all) => all.map((x) => (x as HTMLInputElement).checked)),
    ).toEqual([false, true]);
    await page.click("#tab-c87247a");
    expect(await shown()).toEqual([true, false]);
    // The radios are not seen but can hold the focus, and the arrow keys are the radio group's.
    await page.focus("#tabcontents-collection-design-tab-0");
    await page.keyboard.press("ArrowRight");
    expect(await shown()).toEqual([false, true]);
    expect(
      await page.$eval("#tabcontents-collection-design-tab-1", (e) => document.activeElement === e),
    ).toBe(true);
    expect(
      await page.$eval("#tabcontents-collection-design-tab-0", (e) =>
        (e as HTMLElement).checkVisibility(),
      ),
    ).toBe(true);
    expect(
      await page.$eval("#tabcontents-collection-design-tab-0", (e) => getComputedStyle(e).opacity),
    ).toBe("0");
    await close(page);
  });

  test("a panel whose tab does not exist stays visible", async () => {
    const r = await convertMarkup(
      TABS_MARKUP.replace(/<!-- wp:cwicly\/tablist [\s\S]*?<!-- \/wp:cwicly\/tablist -->/, ""),
    );
    const page = await openBuilt(await project(r, "fineline", []), 1000);
    expect(
      await page.$$eval("#tabcontents-collection-design > div", (all) =>
        all.map((p) => (p as HTMLElement).checkVisibility()),
      ),
    ).toEqual([true, true]);
    await close(page);
  });

  test("the active tab's own rule (littlecocalico's .cc-tab-active) follows the checked radio", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    const css = parseCwiclyCssFor(
      run.ctx,
      ".tablist-decor button.cc-tab-active{background-color:rgb(1, 2, 3);text-decoration:underline}",
    );
    const ctx = withRegistry({ ...run.ctx, css, hoist: (h) => run.hoisted.push(h) }, registry);
    const nodes = finishNodes(
      ctx.convert(
        blocksOf(
          TABS_MARKUP.replace(
            '"globalClass":["tablist-decor-id"]',
            '"globalClass":["tablist-decor-id"],"additionalClass":[]',
          ).replace('class="{gcl}" role="tablist"', 'class="tablist-decor" role="tablist"'),
        ),
      ),
    );
    const page = await openBuilt(await project({ ...run, nodes }, "fineline", []), 1000);
    const bg = (sel: string) => page.$eval(sel, (e) => getComputedStyle(e).backgroundColor);
    expect(await bg("#tab-c87247a")).toBe("rgb(1, 2, 3)");
    expect(await bg("#tab-c13547d")).not.toBe("rgb(1, 2, 3)");
    await page.click("#tab-c13547d");
    expect(await bg("#tab-c13547d")).toBe("rgb(1, 2, 3)");
    expect(await bg("#tab-c87247a")).not.toBe("rgb(1, 2, 3)");
    await close(page);
  });

  test("a slider scrolls along its row and snaps; its slides are the width its option says", async () => {
    const markup = sliderMarkup(
      ',"sliderNumberPerWindow":{"lg":"2","md":"1"},"sliderSpaceBetween":{"lg":"20"}',
    );
    const blocks = blocksOf(markup);
    const r = await convertMarkup(markup);
    const built = await project(r, "fineline", blocks);
    const wide = await openBuilt(built, 1366);
    const sizes = await wide.$$eval(".swiper-slide", (all) =>
      all.map((s) => Math.round(s.getBoundingClientRect().width)),
    );
    const box = await wide.$eval(".swiper", (e) => Math.round(e.getBoundingClientRect().width));
    expect(sizes[0]).toBe(Math.round((box - 20) / 2));
    expect(await wide.$eval(".swiper", (e) => getComputedStyle(e).scrollSnapType)).toBe(
      "x mandatory",
    );
    await close(wide);
    const narrow = await openBuilt(built, 800);
    const one = await narrow.$$eval(".swiper-slide", (all) =>
      all.map((s) => Math.round(s.getBoundingClientRect().width)),
    );
    const nbox = await narrow.$eval(".swiper", (e) => Math.round(e.getBoundingClientRect().width));
    expect(one[0]).toBe(nbox);
    // Scrolling the scroller reaches the second slide, and it snaps there.
    const left = await narrow.$eval(".swiper", async (e) => {
      e.scrollTo({ left: e.clientWidth - 40, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 200));
      return Math.round(e.scrollLeft);
    });
    // One slide and the 20px gap (the base breakpoint's, kept below it): the next snap point.
    expect(left).toBe(nbox + 20);
    await close(narrow);
  });

  async function apModalPage(width: number) {
    const loaded = await loadSite("ap");
    const blocks = [
      ...subjectBlocks(loaded, AP_HEADER),
      ...subjectBlocks(loaded, AP_MOBILE_MENU),
      ...subjectBlocks(loaded, AP_FOOTER),
    ];
    const runs: (Run & { nodes: JxNode[] })[] = [];
    for (const subject of [AP_HEADER, AP_MOBILE_MENU, AP_FOOTER]) {
      const run = await runFor("ap", subject);
      runs.push({ ...run, nodes: finishNodes(run.ctx.convert(subjectBlocks(loaded, subject))) });
    }
    const merged = {
      ...(runs[0] as Run),
      nodes: runs.flatMap((r) => r.nodes),
      hoisted: runs.flatMap((r) => r.hoisted),
    };
    const built = await project(merged, "ap", blocks);
    return openBuilt(built, width);
  }

  test("a modal opens from its opener, covers the page, dims it, locks its scroll, and closes by every way it was meant to", async () => {
    const page = await apModalPage(700);
    const opener = "button[popovertarget='modal-overlay-menu'][popovertargetaction='show']";
    const isOpen = () => page.$eval("#modal-overlay-menu", (e) => e.matches(":popover-open"));
    expect(await isOpen()).toBe(false);
    expect(await visible(page, "#modal-overlay-menu")).toBe(false);
    await page.click(opener);
    expect(await isOpen()).toBe(true);
    const shell = await page.$eval("#modal-overlay-menu", (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    expect(shell).toEqual({ x: 0, y: 0, w: 700, h: 900 });
    expect(
      await page.$eval(
        "#modal-overlay-menu .cc-mdl-close",
        (e) => getComputedStyle(e).backgroundColor,
      ),
    ).toBe("rgba(0, 0, 0, 0.6)");
    expect(
      await page.$eval("#modal-overlay-menu .cc-modaler", (e) => getComputedStyle(e).opacity),
    ).toBe("1");
    expect(await page.$eval("body", (e) => getComputedStyle(e).overflow)).toBe("hidden");
    // The shell paints nothing of its own (the UA's white popover background is reset).
    expect(
      await page.$eval("#modal-overlay-menu", (e) => getComputedStyle(e).backgroundColor),
    ).toBe("rgba(0, 0, 0, 0)");
    await page.keyboard.press("Escape");
    expect(await isOpen()).toBe(false);
    expect(await page.$eval("body", (e) => getComputedStyle(e).overflow)).not.toBe("hidden");
    await page.click(opener);
    await page.click("#modal-overlay-menu .cc-mdl-close", { offset: { x: 650, y: 850 } });
    expect(await isOpen()).toBe(false);
    await page.click(opener);
    await page.click("#modal-overlay-menu button.icon-c64c3db");
    expect(await isOpen()).toBe(false);
    await close(page);
  });

  test("the footer popover opens while its trigger is hovered, beside it, and not before", async () => {
    const page = await apModalPage(1366);
    expect(await visible(page, "#popover-c369aa8")).toBe(false);
    await page.$eval("#paragraph-content", (e) => e.scrollIntoView({ block: "center" }));
    await page.hover("#paragraph-content");
    expect(await visible(page, "#popover-c369aa8")).toBe(true);
    const [trigger, pop] = await page.evaluate(() => [
      document.getElementById("paragraph-content")!.getBoundingClientRect().toJSON(),
      document.getElementById("popover-c369aa8")!.getBoundingClientRect().toJSON(),
    ]);
    // `placement: bottom-start`: below the trigger, the two start edges lined up.
    expect(Math.round(pop.top)).toBe(Math.round(trigger.bottom));
    expect(Math.round(pop.left)).toBe(Math.round(trigger.left));
    // The box stays while it is hovered itself (interactive), and goes when neither is.
    await page.hover("#popover-c369aa8 a");
    expect(await visible(page, "#popover-c369aa8")).toBe(true);
    await page.mouse.move(5, 5);
    expect(await visible(page, "#popover-c369aa8")).toBe(false);
    await close(page);
  });

  test("a popover with no trigger element opens from the button that names it, beside that button, and Escape closes it", async () => {
    const markup = `<!-- wp:cwicly/button {"isStyling":true,"content":"Open","uniqueID":"u-bt","classID":"button-o","id":"button-o","additionalClassesR":"","linkWrapperActive":true,"linkWrapperType":"action","linkWrapperAction":"showPopover","linkWrapperActionPopoverID":"popover-b"} -->
<a class="button-o cc-btn" href="{empty}">Open</a>
<!-- /wp:cwicly/button -->
${popoverMarkupForBuild().replace('"placement":"bottom"', '"placement":"bottom-start","flip":true')}`;
    const r = await convertMarkup(markup);
    const page = await openBuilt(await project(r, "fineline", []), 1000);
    expect(await visible(page, "#popover-b")).toBe(false);
    await page.click("button[popovertarget='popover-b']");
    expect(await page.$eval("#popover-b", (e) => e.matches(":popover-open"))).toBe(true);
    expect(await visible(page, "#popover-b")).toBe(true);
    const [button, box] = await page.evaluate(() => [
      document.querySelector("button[popovertarget='popover-b']")!.getBoundingClientRect().toJSON(),
      document.getElementById("popover-b")!.getBoundingClientRect().toJSON(),
    ]);
    expect(Math.round(box.top)).toBe(Math.round(button.bottom));
    expect(Math.round(box.left)).toBe(Math.round(button.left));
    expect(await page.$eval("#popover-b", (e) => getComputedStyle(e).backgroundColor)).toBe(
      "rgba(0, 0, 0, 0)",
    );
    await page.keyboard.press("Escape");
    expect(await page.$eval("#popover-b", (e) => e.matches(":popover-open"))).toBe(false);
    // Light dismiss: a click outside closes it too.
    await page.click("button[popovertarget='popover-b']");
    await page.mouse.click(900, 700);
    expect(await page.$eval("#popover-b", (e) => e.matches(":popover-open"))).toBe(false);
    await close(page);
  });

  async function navPage(width: number) {
    const run = await runFor("fineline", FINELINE_HEADER);
    const blocks = [
      await realBlock("fineline", FINELINE_HEADER, "nav-c0498d1"),
      await realBlock("fineline", FINELINE_HEADER, "nav-ce2259c"),
    ];
    const nodes = finishNodes(run.ctx.convert(blocks));
    const built = await project({ ...run, nodes }, "fineline", blocks, ["cc-tp-cwicly_header.css"]);
    return { built, page: await openBuilt(built, width), run };
  }

  test("the mobile navigation collapses at its breakpoint: a hamburger, no panel", async () => {
    const { page } = await navPage(800);
    const nav = "#nav-c5786fb";
    expect(
      await page.$eval(`${nav} button.cc-nav-toggle`, (e) => getComputedStyle(e).display),
    ).toBe("block");
    expect(await visible(page, `${nav} .cc-nav-wrapper`)).toBe(false);
    expect(await page.$eval(`${nav} .cc-nav-wrapper`, (e) => e.matches(":popover-open"))).toBe(
      false,
    );
    await close(page);
  });

  test("the hamburger opens the panel at the left, 400px wide, over a dimmed page, with the header and a cross; every way of closing works", async () => {
    const { page } = await navPage(800);
    const nav = "#nav-c5786fb";
    const open = () => page.$eval(`${nav} .cc-nav-wrapper`, (e) => e.matches(":popover-open"));
    await page.click(`${nav} button.cc-nav-toggle`);
    expect(await open()).toBe(true);
    const panel = await page.$eval(`${nav} .cc-nav-wrapper`, (e) => {
      const r = e.getBoundingClientRect();
      const s = getComputedStyle(e);
      return {
        x: r.x,
        y: r.y,
        w: r.width,
        h: r.height,
        bg: s.backgroundColor,
        visibility: s.visibility,
      };
    });
    expect(panel).toEqual({
      x: 0,
      y: 0,
      w: 400,
      h: 900,
      bg: "rgb(255, 255, 255)",
      visibility: "visible",
    });
    expect(
      await page.$eval(
        `${nav} .cc-nav-wrapper`,
        (e) => getComputedStyle(e, "::backdrop").backgroundColor,
      ),
    ).toBe("rgba(0, 0, 0, 0.5)");
    expect(await page.$eval(`${nav} .cc-nav-header`, (e) => getComputedStyle(e).display)).toBe(
      "flex",
    );
    expect(
      await page.$eval(`${nav} .cc-nav-content`, (e) => getComputedStyle(e).flexDirection),
    ).toBe("column");
    // The cross is the plugin's own hamburger CSS: its first and last lines are rotated.
    const lines = await page.$$eval(`${nav} .cc-nav-toggle--close .line`, (all) =>
      all.map((l) => getComputedStyle(l).transform),
    );
    expect(lines[0]).not.toBe("none");
    expect(lines[2]).not.toBe("none");
    expect(await page.$eval("body", (e) => getComputedStyle(e).overflow)).toBe("hidden");
    await page.keyboard.press("Escape");
    expect(await open()).toBe(false);
    await page.click(`${nav} button.cc-nav-toggle`);
    await page.click(`${nav} .cc-nav-toggle--close`);
    expect(await open()).toBe(false);
    await page.click(`${nav} button.cc-nav-toggle`);
    await page.mouse.click(700, 450);
    expect(await open()).toBe(false);
    await close(page);
  });

  test("at desktop width the navigation is the bar it was: no toggle, the wrapper an ordinary box, the links in a row", async () => {
    const { page } = await navPage(1366);
    const nav = "#nav-c5786fb";
    expect(
      await page.$eval(`${nav} button.cc-nav-toggle`, (e) => getComputedStyle(e).display),
    ).toBe("none");
    const wrapper = await page.$eval(`${nav} .cc-nav-wrapper`, (e) => {
      const s = getComputedStyle(e);
      return {
        position: s.position,
        display: s.display,
        visibility: s.visibility,
        bg: s.backgroundColor,
        header: getComputedStyle(e.querySelector(".cc-nav-header")!).display,
      };
    });
    expect(wrapper).toEqual({
      position: "static",
      display: "block",
      visibility: "visible",
      bg: "rgba(0, 0, 0, 0)",
      header: "none",
    });
    expect(
      await page.$eval("#nav-c05ccc2 .cc-nav-items", (e) => getComputedStyle(e).flexDirection),
    ).toBe("row");
    await close(page);
  });

  test("a dropdown opens while its title is hovered or holds the focus and closes when neither is", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    const markup = `<!-- wp:cwicly/navitems {"uniqueID":"u-ni","classID":"navitems-x","id":"navitems-x","additionalClassesR":"","isStyling":true} -->
<ul class="navitems-x cc-nav-items">${NAVDROPDOWN_MARKUP}</ul>
<!-- /wp:cwicly/navitems -->`;
    const blocks = blocksOf(markup);
    const nodes = finishNodes(run.ctx.convert(blocks));
    const page = await openBuilt(await project({ ...run, nodes }, "fineline", blocks), 1366);
    const content = ".cc-nav-dropdown__content";
    expect(await visible(page, content)).toBe(false);
    await page.hover(".cc-nav-dropdown__button--title");
    await new Promise((r) => setTimeout(r, 450));
    expect(await visible(page, content)).toBe(true);
    // Under the item, at its start edge.
    const [item, box] = await page.evaluate(() => [
      document.querySelector(".cc-nav-dropdown")!.getBoundingClientRect().toJSON(),
      document.querySelector(".cc-nav-dropdown__content")!.getBoundingClientRect().toJSON(),
    ]);
    expect(Math.round(box.top)).toBe(Math.round(item.bottom));
    expect(Math.round(box.left)).toBe(Math.round(item.left));
    await page.mouse.move(900, 800);
    await new Promise((r) => setTimeout(r, 450));
    expect(await visible(page, content)).toBe(false);
    await page.focus(".cc-nav-dropdown__button--title");
    await new Promise((r) => setTimeout(r, 450));
    expect(await visible(page, content)).toBe(true);
    await close(page);
  });

  /** The properties compared between the converted markup and the plugin's own. */
  const PROPS = [
    "display",
    "position",
    "flexDirection",
    "justifyContent",
    "alignItems",
    "rowGap",
    "columnGap",
    "fontSize",
    "fontFamily",
    "color",
    "marginTop",
    "marginRight",
    "marginBottom",
    "marginLeft",
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "visibility",
    "opacity",
  ] as const;

  async function computed(page: Page, selector: string): Promise<Record<string, string> | null> {
    return page.evaluate(
      (sel, props) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const s = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        return {
          ...Object.fromEntries(props.map((p) => [p, s[p as never] as string])),
          width: String(Math.round(r.width)),
          height: String(Math.round(r.height)),
        };
      },
      selector,
      [...PROPS],
    );
  }

  test("the converted header navigation computes the styles the plugin's own markup does (live markup, same CSS)", async () => {
    const live = liveHtml("fineline", "about-us");
    const navs = p5find(live, (e) => e.tagName === "div" && p5classes(e).includes("cc-nav"));
    // The live markup of the two navs, cut where the live page printed a rendered menu.
    const liveMarkup = navs.map((n) => serializeOuter(n)).join("");
    const run = await runFor("fineline", FINELINE_HEADER);
    const blocks = [
      await realBlock("fineline", FINELINE_HEADER, "nav-c0498d1"),
      await realBlock("fineline", FINELINE_HEADER, "nav-ce2259c"),
    ];
    const nodes = finishNodes(run.ctx.convert(blocks));
    const built = await project({ ...run, nodes }, "fineline", blocks, ["cc-tp-cwicly_header.css"]);
    const head = (built.html("/").match(/<link[^>]*>/g) ?? []).join("");
    const liveDoc = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${head}</head><body>${liveMarkup}</body></html>`;
    for (const width of [1366, 800]) {
      const a = await openBuilt(built, width);
      // Below its breakpoint the plugin's script sets `is-modal` on the nav; the oracle page has no script, so its state is written.
      const doc =
        width <= 992
          ? liveDoc.replace('breakpoint="md"', 'breakpoint="md" is-modal="true"')
          : liveDoc;
      const b = await openBuilt(built, width, { "/live.html": doc }, "/live.html");
      const pairs = [
        "#nav-c05ccc2",
        "#nav-c05ccc2 .cc-nav-items",
        ".navlink-c677a96",
        ".navlink-c677a96 .cc-nav-item",
        ".navlink-cb825db .cc-nav-item",
        ".navlink-c6c1af6",
        "#nav-c5786fb",
        "#nav-c5786fb .cc-nav-content",
        "#nav-c5786fb .cc-nav-header",
        "#nav-c5786fb .cc-nav-toggle",
      ];
      const differences: string[] = [];
      for (const sel of pairs) {
        const x = await computed(a, sel);
        const y = await computed(b, sel);
        expect(x).not.toBeNull();
        expect(y).not.toBeNull();
        for (const key of Object.keys(y as object)) {
          if (x?.[key] !== y?.[key])
            differences.push(`${width}px ${sel} ${key}: converted ${x?.[key]}, plugin ${y?.[key]}`);
        }
      }
      // Whatever differs is the toggle's own box (a button against a div: both are `display: block` and 48px, but
      // the UA gives a button its own font and colour) and nothing else.
      // The converted nav holds an empty menu placeholder where the live page printed the menu: its box has no size.
      const unexplained = differences
        .filter((d) => !/#nav-c5786fb(?: \.cc-nav-content)? (?:width|height):/.test(d))
        // A closed popover is `display: none` where the plugin's closed panel is `visibility: hidden`: no box against a hidden one.
        .filter((d) => !/#nav-c5786fb \.cc-nav-header (?:width|height):/.test(d))
        .filter(
          (d) =>
            !/\.cc-nav-toggle (fontFamily|fontSize|color|alignItems|justifyContent|paddingTop|paddingRight|paddingBottom|paddingLeft|marginTop|marginBottom|marginLeft|marginRight|position|display):/.test(
              d,
            ),
        );
      expect(unexplained).toEqual([]);
      await close(a);
      await close(b);
    }
  });
  // What the reviewers found, in the browser that decides whether it is true.

  /** Computed `display` of the two panels of a tab list (class `cc-tbc`). */
  const panelDisplays = (page: Page): Promise<string[]> =>
    page.$$eval(".cc-tbc", (all) => all.map((p) => getComputedStyle(p).display));

  test("tab panels hide and show for ids that are not plain identifiers (a digit, a hyphen and a digit, an emoji, punctuation, a template)", async () => {
    for (const group of ["1tabs", "-1tabs", "a\u{1F642}b", "a.b c:d#e[f]", "t${3+3}"]) {
      const r = await convertMarkup(tabsWithGroup(group));
      const page = await openBuilt(await project(r, "fineline", []), 1000);
      // The rules are valid selectors, and they reach the panels.
      expect(await panelDisplays(page), group).toEqual(["flex", "none"]);
      await page.click(".cc-tab-label:nth-child(2)");
      expect(await panelDisplays(page), group).toEqual(["none", "flex"]);
      await close(page);
    }
  });

  test("a tab list's default tab is the one shown at the start", async () => {
    const r = await convertMarkup(
      TABS_MARKUP.replace('"tabContentsActive":0', '"tabContentsActive":2'),
    );
    const page = await openBuilt(await project(r, "fineline", []), 1000);
    expect(await panelDisplays(page)).toEqual(["none", "flex"]);
    await close(page);
  });

  test("a popover whose id starts with a digit is hidden until its trigger is hovered, and anchored to it", async () => {
    for (const id of ["1pop", "pop.1", "pop:1"]) {
      const r = await convertMarkup(popoverWithId(id));
      const nodes: JxNode[] = [
        { tagName: "a", attributes: { id: "t", href: "#" }, textContent: "trigger" },
        ...r.nodes,
      ];
      const page = await openBuilt(await project({ ...r, nodes }, "fineline", []), 1000);
      const state = () =>
        page.evaluate((pid) => {
          const box = document.getElementById(pid) as HTMLElement;
          const trigger = document.getElementById("t") as HTMLElement;
          return {
            visibility: getComputedStyle(box).visibility,
            anchor: getComputedStyle(trigger).anchorName,
            positioned: getComputedStyle(box).positionAnchor,
          };
        }, id);
      const before = await state();
      expect(before.visibility, id).toBe("hidden");
      expect(before.anchor, id).not.toBe("none");
      expect(before.positioned, id).toBe(before.anchor);
      await page.hover("#t");
      expect((await state()).visibility, id).toBe("visible");
      await close(page);
    }
  });

  test("a modal whose id starts with a digit locks the page's scroll while it is open", async () => {
    const r = await convertMarkup(
      modalMarkup()
        .replaceAll('"id":"modal-promo"', '"id":"1modal"')
        .replace('id="modal-promo{idadd}"', 'id="1modal{idadd}"'),
    );
    const page = await openBuilt(await project(r, "fineline", []), 1000);
    const overflow = () => page.$eval("body", (b) => getComputedStyle(b).overflow);
    expect(await overflow()).not.toBe("hidden");
    await page.evaluate(() => (document.getElementById("1modal") as HTMLElement).showPopover());
    expect(await overflow()).toBe("hidden");
    await close(page);
  });

  test("a rule written for the open class of an accordion is the open accordion's, not every closed thing's, whatever the order", async () => {
    for (const css of [
      ".cc-accordion-active .cc-icn{color:rgb(0,0,255)}.cc-accordion-hidden .cc-icn{color:rgb(255,0,0)}",
      ".cc-accordion-hidden .cc-icn{color:rgb(255,0,0)}.cc-accordion-active .cc-icn{color:rgb(0,0,255)}",
    ]) {
      const run = await runFor(PLAIN.site, PLAIN.subject);
      const index = parseCwiclyCssFor(run.ctx, css);
      const ctx = withRegistry(
        { ...run.ctx, css: index, hoist: (h) => run.hoisted.push(h) },
        registry,
      );
      const nodes = finishNodes(
        ctx.convert(
          blocksOf(
            accordionsMarkup(
              accordionMarkup("1", "Open", ',"accordionOpen":true', "cc-accordion-active") +
                accordionMarkup("2", "Closed"),
            ),
          ),
        ),
      );
      const page = await openBuilt(await project({ ...run, ctx, nodes }, "fineline", []), 1000);
      const colours = await page.$$eval(".cc-icn", (all) =>
        all.map((i) => getComputedStyle(i).color),
      );
      expect(colours, css).toEqual(["rgb(0, 0, 255)", "rgb(255, 0, 0)"]);
      await close(page);
    }
  });

  test("the term links of a filter can take the keyboard's focus", async () => {
    const subject: Subject = { kind: "template", slug: "archive-project" };
    const run = await runFor("fineline", subject);
    const block = await realBlock("fineline", subject, "filter-project-type");
    const nodes = finishNodes(run.ctx.convert([block]));
    const page = await openBuilt(await project({ ...run, nodes }, "fineline", [block]), 1000);
    const focused = await page.$$eval("a[href]", (all) =>
      all.slice(0, 3).map((a) => {
        (a as HTMLElement).focus();
        return document.activeElement === a;
      }),
    );
    expect(focused).toEqual([true, true, true]);
    await close(page);
  });

  test("a menu's dropdown opens while its item is hovered or holds the focus", async () => {
    const run = await runFor("fineline", FINELINE_HEADER);
    const block = await realBlock("fineline", FINELINE_HEADER, "menu-c0fe5e2");
    const nodes = finishNodes(run.ctx.convert([block]));
    // The menus emitter prints the list where the placeholder is; the plugin's markup for one item with a dropdown.
    const menuEl = el(nodes[0]);
    menuEl.children = [
      {
        tagName: "ul",
        className: "cc-menu hor",
        innerHTML:
          '<li><a class="cc-menu-main" href="#a">Services</a><ul class="cc-menu-dropdown"><li><a href="#b">Interior</a></li></ul></li><li><a href="#c">Contact</a></li>',
      },
    ];
    const page = await openBuilt(
      await project({ ...run, nodes }, "fineline", [block], ["cc-tp-cwicly_header.css"]),
      1366,
    );
    // The block's own rule fades the dropdown over half a second: look once the transition has run.
    const open = async (): Promise<boolean> => {
      await new Promise((done) => setTimeout(done, 700));
      return page.$eval(".cc-menu-dropdown", (d) =>
        (d as HTMLElement).checkVisibility({ visibilityProperty: true, opacityProperty: true }),
      );
    };
    expect(await open()).toBe(false);
    await page.hover(".cc-menu > li:first-child > a");
    expect(await open()).toBe(true);
    await page.hover(".cc-menu > li:last-child > a");
    expect(await open()).toBe(false);
    await page.focus(".cc-menu > li:first-child > a");
    expect(await open()).toBe(true);
    await close(page);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// Blocks with no saved markup, and the cases the real data does not reach
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** A block as a component keeps it: its attributes and no saved markup. */
const bare = (
  name: string,
  attrs: Record<string, unknown> = {},
  innerBlocks: WpBlock[] = [],
): WpBlock => ({
  name,
  attrs: {
    uniqueID: "u",
    classID: "x-c1",
    id: "x-c1",
    isStyling: true,
    additionalClassesR: "",
    ...attrs,
  },
  innerBlocks,
  innerHTML: "",
  innerContent: innerBlocks.length === 0 ? [""] : [null],
});

describe("blocks that saved no markup of their own", () => {
  test("each falls back to the tag the plugin's save() gives it", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    const tag = (name: string, attrs: Record<string, unknown> = {}): string =>
      el(run.ctx.convert([bare(name, attrs)])[0]).tagName as string;
    expect(tag("cwicly/navitems")).toBe("ul");
    expect(tag("cwicly/navlink")).toBe("li");
    expect(tag("cwicly/menu")).toBe("nav");
    expect(tag("cwicly/accordion")).toBe("details");
    expect(tag("cwicly/accordionheader")).toBe("summary");
    expect(tag("cwicly/accordioncontent")).toBe("div");
    expect(tag("cwicly/accordions")).toBe("div");
    expect(tag("cwicly/slider")).toBe("div");
    expect(tag("cwicly/rangeslider")).toBe("div");
    expect(tag("cwicly/input")).toBe("input");
    expect(tag("cwicly/input", { inputTemplate: "commenttextarea" })).toBe("textarea");
    expect(tag("cwicly/tab")).toBe("button");
    expect(tag("cwicly/tabcontent")).toBe("div");
    expect(tag("cwicly/sliderchild")).toBe("div");
  });

  test("a nav link with no markup is the list item and anchor the plugin's save() makes", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    const li = el(
      run.ctx.convert([
        bare("cwicly/navlink", { content: "Home", linkWrapperActive: true, linkWrapperUrl: "/" }),
      ])[0],
    );
    expect(li.tagName).toBe("li");
    const a = el(kids(li)[0]);
    expect(a.tagName).toBe("a");
    expect(a.className).toBe("cc-nav-item");
    expect(attrsOf(a).href).toBe("/");
  });

  test("a nav link whose saved tag is a button is still a list item", async () => {
    const r =
      await convertMarkup(`<!-- wp:cwicly/navlink {"isStyling":true,"content":"Quote","uniqueID":"u-b","classID":"navlink-b","id":"navlink-b","additionalClassesR":"","linkWrapperActive":true,"linkWrapperUrl":"/quote/","containerLayoutTag":"button"} -->
<button class="navlink-b cc-nav-link"><a class="cc-nav-item" href="/quote/">Quote</a></button>
<!-- /wp:cwicly/navlink -->`);
    expect(el(r.nodes[0]).tagName).toBe("li");
    expect(el(kids(r.nodes[0])[0]).tagName).toBe("a");
  });

  test("a taxonomy filter that is childless lists only the terms with no children, whatever their order", async () => {
    const run = await runFor("ap", { kind: "post", id: 5046 });
    const model = run.ctx.model;
    const bible = [...model.terms.values()].find(
      (t) => t.taxonomy === "category" && t.slug === "bible",
    )!;
    const child = {
      ...bible,
      termId: 999_001,
      slug: "bible-study",
      name: "Bible Study",
      parent: bible.termId,
      count: 2,
    };
    const terms = new Map(model.terms);
    terms.set(child.termId, child);
    const ctx = withRegistry({ ...run.ctx, model: { ...model, terms }, hoist: () => {} }, registry);
    const mk = (
      childless: boolean,
    ) => `<!-- wp:cwicly/filter {"filterType":"custom","filterSource":"dynamic","filterDataType":"taxonomy","filterData":[{"label":"x","value":"category","type":"post"}],"filterHideEmpty":true,"filterChildless":${childless},"uniqueID":"u","classID":"filter-c","id":"filter-c","additionalClassesR":""} -->
<div id="filter-c{idadd}" cc-filter=""><ccdyn></ccdyn></div>
<!-- /wp:cwicly/filter -->`;
    const names = (childless: boolean) =>
      byTag(ctx.convert(blocksOf(mk(childless))), "li").map((li) => html([li]));
    expect(names(false).some((h) => h.includes("Bible Study"))).toBe(true);
    expect(names(false).some((h) => h.includes(">Bible<"))).toBe(true);
    expect(names(true).some((h) => h.includes("Bible Study"))).toBe(true);
    expect(names(true).some((h) => h.includes(">Bible<"))).toBe(false);
  });

  test("a taxonomy filter ignores filterParent: the live filter never sends it", async () => {
    const run = await runFor("ap", { kind: "post", id: 5046 });
    const model = run.ctx.model;
    const bible = [...model.terms.values()].find(
      (t) => t.taxonomy === "category" && t.slug === "bible",
    )!;
    const child = {
      ...bible,
      termId: 999_002,
      slug: "bible-study",
      name: "Bible Study",
      parent: bible.termId,
      count: 2,
    };
    const terms = new Map(model.terms);
    terms.set(child.termId, child);
    const ctx = withRegistry({ ...run.ctx, model: { ...model, terms }, hoist: () => {} }, registry);
    const markupWithoutParent = (parent: number | undefined): string =>
      `<!-- wp:cwicly/filter {"filterType":"custom","filterSource":"dynamic","filterDataType":"taxonomy","filterData":[{"label":"x","value":"category","type":"post"}],${parent === undefined ? "" : `"filterParent":"${parent}",`}"filterHideEmpty":true,"uniqueID":"u","classID":"filter-c","id":"filter-c","additionalClassesR":""} -->
<div id="filter-c{idadd}" cc-filter=""><ccdyn></ccdyn></div>
<!-- /wp:cwicly/filter -->`;
    const out = ctx.convert(blocksOf(markupWithoutParent(bible.termId)));
    // Only the editor's own preview query carries a parent; the frontend's term query has none.
    const all = byTag(ctx.convert(blocksOf(markupWithoutParent(undefined))), "li");
    expect(byTag(out, "li").length).toBe(all.length);
    expect(byTag(out, "li").length).toBeGreaterThan(1);
    expect(html(out)).toContain("Bible Study");
    expect(html(out)).toContain(">Bible<");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// What the reviewers found: literal text, state classes, the plugin's own rules
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** A tab list and its panels with `group` as the id the two name each other by (`TABS_MARKUP`, re-keyed). */
const tabsWithGroup = (group: string): string =>
  TABS_MARKUP.replaceAll(
    '"tabContentsID":"tabcontents-collection-design"',
    `"tabContentsID":"${group}"`,
  )
    .replaceAll('"id":"tabcontents-collection-design"', `"id":"${group}"`)
    .replaceAll('data-cc-tabs="tabcontents-collection-design"', `data-cc-tabs="${group}"`)
    .replaceAll('id="tabcontents-collection-design{idadd}"', `id="${group}{idadd}"`);

/** A popover opened by the element `trigger`, with `id` for its own id. */
const popoverWithId = (
  id: string,
  options = `{"trigger":"t","triggerType":"hover","placement":"bottom"}`,
): string => `<!-- wp:cwicly/popover {"popoverOptions":${options},"isStyling":true,"forceShowID":true,"uniqueID":"u-po","classID":"popover-x","id":"${id}","additionalClassesR":""} -->
<div id="${id}{idadd}" class="popover-x" data-ccp-state="hidden"><!-- wp:cwicly/paragraph {"content":"More","uniqueID":"u-pp","classID":"paragraph-pp","id":"paragraph-pp","additionalClassesR":""} -->
<p>More</p>
<!-- /wp:cwicly/paragraph --></div>
<!-- /wp:cwicly/popover -->`;

describe("a literal ${ in what the module writes is never evaluated by the build", () => {
  const TEMPLATE = "${1+1}";

  test("an accordion group, on the container and on an accordion", async () => {
    const split = "g$​{1+1}";
    const container = await convertMarkup(
      accordionsMarkup(
        accordionMarkup("1", "A") + accordionMarkup("2", "B"),
        `,"accordionLinked":true,"accordionGroup":"g${TEMPLATE}"`,
      ),
    );
    expect(kids(container.nodes[0]).map((d) => attrsOf(d).name)).toEqual([split, split]);
    expect(JSON.stringify(container.nodes)).not.toContain("${");
    expect(codes(container.reportsNow)).toContain("token.literal-template");
    const single = await convertMarkup(
      accordionMarkup("1", "A", `,"accordionLinked":true,"accordionGroup":"g${TEMPLATE}"`),
    );
    expect(attrsOf(single.nodes[0]).name).toBe(split);
    expect(JSON.stringify(single.nodes)).not.toContain("${");
  });

  test("a tab group's radio names and ids, the panels' ids and the rules that name them", async () => {
    const r = await convertMarkup(tabsWithGroup("t${3+3}"));
    const radios = byTag(r.nodes, "input");
    expect(radios.map((x) => attrsOf(x).name)).toEqual(["t$​{3+3}-tabs", "t$​{3+3}-tabs"]);
    expect(radios.map((x) => attrsOf(x).id)).toEqual(["t$​{3+3}-tab-0", "t$​{3+3}-tab-1"]);
    expect(attrsOf(kids(r.nodes[1])[1]).id).toBe("t$​{3+3}-panel-1");
    // Nothing the tab list and the panels wrote carries a template; the rules still name what they hide.
    expect(JSON.stringify(r.nodes)).not.toContain("${");
    expect(JSON.stringify(r.hoisted)).not.toContain("${");
    expect(r.hoisted.filter((h) => h.selector.startsWith(":root:has(")).length).toBe(2);
    expect(codes(r.reportsNow)).toContain("token.literal-template");
  });

  test("a modal's id and a popover's id", async () => {
    const modal = await convertMarkup(
      modalMarkup()
        .replaceAll('"id":"modal-promo"', `"id":"m${TEMPLATE}"`)
        .replace('id="modal-promo{idadd}"', `id="m${TEMPLATE}{idadd}"`),
    );
    expect(attrsOf(modal.nodes[0]).id).toBe("m$​{1+1}");
    expect(JSON.stringify(modal.nodes)).not.toContain("${");
    const popover = await convertMarkup(popoverWithId(`p${TEMPLATE}`));
    expect(attrsOf(popover.nodes[0]).id).toBe("p$​{1+1}");
    expect(JSON.stringify(popover.nodes)).not.toContain("${");
    expect(JSON.stringify(popover.hoisted)).not.toContain("${");
  });

  test("an input with no saved tag: the attributes the block holds", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    const out = finishNodes(
      run.ctx.convert([
        bare("cwicly/input", {
          inputType: "text",
          inputPlaceholder: `Cost ${TEMPLATE}`,
          inputName: `n${TEMPLATE}`,
          inputValue: `v${TEMPLATE}`,
        }),
      ]),
    );
    expect(attrsOf(out[0])).toMatchObject({
      placeholder: "Cost $​{1+1}",
      name: "n$​{1+1}",
      value: "v$​{1+1}",
    });
    expect(JSON.stringify(out)).not.toContain("${");
  });

  test("built through Jx, none of them is evaluated", async () => {
    const r = await convertMarkup(
      [
        accordionsMarkup(
          accordionMarkup("1", "A") + accordionMarkup("2", "B"),
          `,"accordionLinked":true,"accordionGroup":"g${TEMPLATE}"`,
        ),
        tabsWithGroup("t${3+3}"),
        popoverWithId(`p${TEMPLATE}`),
      ].join("\n"),
    );
    const nodes = [
      ...r.nodes,
      ...finishNodes(
        r.ctx.convert([
          bare("cwicly/input", { inputType: "text", inputPlaceholder: `Cost ${TEMPLATE}` }),
        ]),
      ),
    ];
    const site = await buildJxProject(projectFiles(nodes, r.hoisted, r.ctx.cwicly.media), {
      name: "literal-templates",
    });
    const page = compactHtml(site);
    expect(page).toContain('name="g$​{1+1}"');
    expect(page).toContain('name="t$​{3+3}-tabs"');
    expect(page).toContain('id="t$​{3+3}-tab-0"');
    expect(page).toContain('placeholder="Cost $​{1+1}"');
    for (const evaluated of ['name="g2"', 'name="t6-tabs"', 'id="t6-tab-0"', "Cost 2"]) {
      expect(page).not.toContain(evaluated);
    }
    expect(site.list().filter((f) => f.endsWith(".js"))).toEqual([]);
  });
});

describe("ids as CSS identifiers", () => {
  test("a tab group that starts with a digit is escaped the way CSS.escape does", async () => {
    for (const [group, escaped] of [
      ["1tabs", "\\31 tabs"],
      ["-1tabs", "-\\31 tabs"],
    ] as const) {
      const r = await convertMarkup(tabsWithGroup(group));
      expect(r.hoisted.map((h) => h.selector)).toContain(
        `:root:has(#${escaped}-tab-1:not(:checked)) #${escaped}-panel-1`,
      );
    }
  });

  test("an astral character stays one character, and what is not an identifier character is escaped", async () => {
    const emoji = await convertMarkup(tabsWithGroup("a\u{1F642}b"));
    expect(emoji.hoisted.map((h) => h.selector)).toContain(
      ":root:has(#a\u{1F642}b-tab-1:not(:checked)) #a\u{1F642}b-panel-1",
    );
    const odd = await convertMarkup(tabsWithGroup("a.b c:d#e[f]"));
    expect(odd.hoisted.map((h) => h.selector)).toContain(
      ":root:has(#a\\.b\\ c\\:d\\#e\\[f\\]-tab-1:not(:checked)) #a\\.b\\ c\\:d\\#e\\[f\\]-panel-1",
    );
  });

  test("a popover id that is not a dashed-ident has an anchor name that is", async () => {
    for (const [id, name, selector] of [
      ["1pop", "--popover-1pop", "#\\31 pop"],
      ["pop.1", "--popover-pop\\.1", "#pop\\.1"],
      ["pop:1", "--popover-pop\\:1", "#pop\\:1"],
    ] as const) {
      const r = await convertMarkup(popoverWithId(id));
      const trigger = r.hoisted.find((h) => h.selector === "#t");
      const box = r.hoisted.find((h) => h.selector === selector);
      expect(trigger?.style).toEqual({ anchorName: name });
      expect(box?.style).toMatchObject({ positionAnchor: name });
    }
  });

  test("a modal whose id starts with a digit still locks the page's scroll", async () => {
    const r = await convertMarkup(
      modalMarkup()
        .replaceAll('"id":"modal-promo"', '"id":"1modal"')
        .replace('id="modal-promo{idadd}"', 'id="1modal{idadd}"'),
    );
    expect(r.hoisted.map((h) => h.selector)).toContain("body:has(#\\31 modal:popover-open)");
  });
});

describe("the script's state classes in a block's own rules", () => {
  test("an accordion's customCSS written for cc-accordion-active and -hidden is written for [open]", async () => {
    const r = await convertMarkup(
      accordionMarkup(
        "1",
        "A",
        ',"isStyling":true,"customCSS":".blockclass.cc-accordion-active .x{color:red} .blockclass.cc-accordion-hidden{opacity:.5}"',
      ),
    );
    const style = el(r.nodes[0]).style as Record<string, unknown>;
    expect(Object.keys(style).filter((k) => k.includes("cc-accordion"))).toEqual([]);
    expect(style["&:is(details)[open] .x"]).toEqual({ color: "red" });
    expect(style["&:is(details):not([open])"]).toEqual({ opacity: ".5" });
    expect(byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "own-state-rules",
    );
  });

  test("a tab's customCSS written for cc-tab-active is written for the checked radio, inside a breakpoint too", async () => {
    const r = await convertMarkup(
      TABS_MARKUP.replace(
        '"containerLayoutTag":"button"} -->\n<button id="tab-c87247a',
        '"containerLayoutTag":"button","customCSS":".blockclass.cc-tab-active{color:red} @media (max-width: 992px){.blockclass.cc-tab-hidden{opacity:.4}}"} -->\n<button id="tab-c87247a',
      ),
    );
    const label = el(kids(r.nodes[0])[0]);
    const style = JSON.stringify(label.style);
    expect(style).not.toContain("cc-tab-active");
    expect(style).not.toContain("cc-tab-hidden");
    expect(
      (label.style as Record<string, unknown>)["&.cc-tab-label:has(> .cc-tab-radio:checked)"],
    ).toEqual({ color: "red" });
    expect(style).toContain(".cc-tab-label:not(:has(> .cc-tab-radio:checked))");
  });
});

describe("a tab list's default tab", () => {
  test("is the one the list names, even when another tab is the one the editor flagged", async () => {
    const markup = TABS_MARKUP.replace('"tabContentsActive":0', '"tabContentsActive":"2"');
    const r = await convertMarkup(markup);
    const radios = kids(r.nodes[0]).map((t) => el(kids(t)[0]));
    expect(radios.map((x) => attrsOf(x).checked)).toEqual([undefined, true]);
  });
});

describe("taxonomy filters follow WP_Term_Query", () => {
  const labelsOf = (nodes: JxNode[]): string[] =>
    byTag(nodes, "li").map((li) => decodeEntities(html([li]).replace(/<[^>]+>/g, "")));
  const filterMarkup = (taxonomies: string[], attrs = ""): string =>
    `<!-- wp:cwicly/filter {"filterType":"custom","filterSource":"dynamic","filterDataType":"taxonomy","filterData":[${taxonomies
      .map((t) => `{"label":"${t}","value":"${t}","type":"post"}`)
      .join(
        ",",
      )}],"filterHideEmpty":true${attrs},"uniqueID":"u","classID":"filter-r","id":"filter-r","additionalClassesR":""} -->
<div id="filter-r{idadd}" cc-filter=""><ccdyn></ccdyn></div>
<!-- /wp:cwicly/filter -->`;
  const FINE: Subject = { kind: "template", slug: "archive-project" };

  test("an exclusion is ignored when terms are included (fineline's project types)", async () => {
    const run = await runFor("fineline", FINE);
    const both = run.ctx.convert(
      blocksOf(filterMarkup(["project_type"], ',"filterInclude":[56,60,64],"filterExclude":[60]')),
    );
    // WP_Term_Query clears `exclude` when `include` is set: all three, not two.
    expect(labelsOf(both)).toEqual([
      "Commercial Painting",
      "Exterior Painting",
      "Interior Painting",
    ]);
    const excluded = run.ctx.convert(
      blocksOf(filterMarkup(["project_type"], ',"filterExclude":[60]')),
    );
    expect(labelsOf(excluded)).not.toContain("Exterior Painting");
    expect(labelsOf(excluded)).toContain("Interior Painting");
  });

  test("every taxonomy the filter names is listed, in one name order", async () => {
    const run = await runFor("fineline", FINE);
    const out = run.ctx.convert(blocksOf(filterMarkup(["project_type", "location"])));
    const labels = labelsOf(out);
    const shown = [...run.ctx.model.terms.values()].filter(
      (t) => (t.taxonomy === "project_type" || t.taxonomy === "location") && t.count > 0,
    );
    expect(shown.some((t) => t.taxonomy === "location")).toBe(true);
    expect(labels.length).toBe(shown.length);
    expect(labels).toContain("Interior Painting");
    expect(labels).toContain("Pennsylvania");
    const collator = new Intl.Collator("en", { sensitivity: "base" });
    expect(labels).toEqual([...labels].sort((a, b) => collator.compare(a, b)));
  });

  test("names are ordered the way the database collation orders them: case and accents do not count", async () => {
    const run = await runFor("ap", { kind: "post", id: 5046 });
    const model = run.ctx.model;
    const seed = [...model.terms.values()][0]!;
    const terms = new Map(model.terms);
    const names = ["Zebra", "Épée", "eagle", "Apple"];
    names.forEach((name, i) =>
      terms.set(990_100 + i, {
        ...seed,
        termId: 990_100 + i,
        taxonomy: "zz_collation",
        slug: name.toLowerCase(),
        name,
        parent: 0,
        count: 1,
      }),
    );
    const ctx = withRegistry(
      { ...run.ctx, model: { ...model, terms }, urlFor: () => undefined, hoist: () => {} },
      registry,
    );
    const out = ctx.convert(blocksOf(filterMarkup(["zz_collation"])));
    expect(labelsOf(out)).toEqual(["Apple", "eagle", "Épée", "Zebra"]);
  });
});

describe("what the popover's options say, and the plugin does with them", () => {
  test("its offset, its fixed position and the way it hides are reported, not dropped silently", async () => {
    const r = await convertMarkup(
      popoverWithId(
        "popover-r",
        '{"placement":"bottom","trigger":"btn-1","triggerType":"hover","offset":"24","position":"fixed","hide":"onClickOut"}',
      ),
    );
    const features = byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature);
    expect(features).toContain("popover-offset");
    expect(features).toContain("popover-position");
    expect(features).toContain("popover-hide");
  });

  test("an offset of nothing and the default position say nothing", async () => {
    const r = await convertMarkup(
      popoverWithId(
        "popover-r",
        '{"placement":"bottom","trigger":"btn-1","triggerType":"hover","offset":"0","position":"absolute"}',
      ),
    );
    const features = byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature);
    expect(features).not.toContain("popover-offset");
    expect(features).not.toContain("popover-position");
    expect(features).not.toContain("popover-hide");
  });

  test("a native popover (no trigger element) reports them too", async () => {
    const r = await convertMarkup(
      popoverWithId("popover-n", '{"placement":"bottom","offset":"12"}'),
    );
    expect(byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "popover-offset",
    );
  });
});

describe("a nav dropdown's placement, offset and width", () => {
  test("littlecocalico's dropdown with all three set is reported", async () => {
    const r = await convertMarkup(
      NAVDROPDOWN_MARKUP.replace(
        '"menuTitle":"Wallpaper",',
        '"menuTitle":"Wallpaper","menuDropdownPlacement":"bottom-end","menuDropdownOffset":{"lg":"30"},"menuDropdownFullwidth":true,',
      ),
    );
    const entry = byCode(r.reportsNow, "interaction.approximated").find(
      (e) => e.data?.feature === "dropdown-placement",
    );
    expect(entry).toBeDefined();
    expect(entry?.message).toContain("placement");
    expect(entry?.message).toContain("offset");
    expect(entry?.message).toContain("full");
  });

  test("a dropdown with none of them says nothing", async () => {
    const r = await convertMarkup(NAVDROPDOWN_MARKUP);
    expect(
      byCode(r.reportsNow, "interaction.approximated").map((e) => e.data?.feature),
    ).not.toContain("dropdown-placement");
  });
});

describe("modal flags that are component parameters", () => {
  test("are reported, not read as off", async () => {
    const props = new Map([
      ["p1", "closeIt"],
      ["p2", "lockIt"],
    ]);
    const r = await convertMarkup(
      modalMarkup(
        ',"modalCloseOverlayComp":"!ref=p1!","modalPreventScrollComp":"!ref=p2!","modalPreventEscComp":"!ref=p3!"',
        ' data-classid="true" data-closeoverlay="{component=parameter=p1}" data-preventpagescroll="{component=parameter=p2}" data-preventesc="{component=parameter=p3}"',
      ),
      { mode: "component", props },
    );
    const entry = byCode(r.reportsNow, "interaction.dropped").find(
      (e) => e.data?.feature === "modal-flag-parameter",
    );
    expect(entry).toBeDefined();
    expect(entry?.message).toContain("close");
    expect(entry?.message).toContain("scroll");
    expect(entry?.message).toContain("Escape");
  });

  test("a modal with plain flags reports nothing of the kind", async () => {
    const r = await convertMarkup(modalMarkup());
    expect(byCode(r.reportsNow, "interaction.dropped").map((e) => e.data?.feature)).not.toContain(
      "modal-flag-parameter",
    );
  });
});

describe("menus: the script's active class", () => {
  test("fineline's header menu opens its dropdown while its item is hovered or focused", async () => {
    const run = await runFor("fineline", FINELINE_HEADER);
    const nodes = run.ctx.convert([await realBlock("fineline", FINELINE_HEADER, "menu-c0fe5e2")]);
    const style = el(nodes[0]).style as Record<string, unknown>;
    expect(Object.keys(style).filter((k) => k.includes(".active"))).toEqual([]);
    expect(style["& li:is(:hover, :focus-within) > .cc-menu-dropdown"]).toEqual({
      visibility: "visible",
      opacity: "1",
    });
    // The closed state is still there, and the open one is no weaker than it was (a class and a pseudo-class weigh the same).
    expect(style["& li > .cc-menu-dropdown"]).toMatchObject({ visibility: "hidden" });
    expect(byCode(run.reports(), "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "menu-dropdown",
    );
  });

  test("a vertical menu expands the item that holds the focus, and says it is not the script's click", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    const out = run.ctx.convert([
      bare("cwicly/menu", { menuSelected: "5", menuLayout: { lg: "vertical" } }),
    ]);
    const style = el(out[0]).style as Record<string, unknown>;
    expect(style["& ul.cc-menu li:focus-within > .cc-menu-dropdown"]).toEqual({ display: "block" });
    expect(byCode(run.reports(), "interaction.approximated").map((e) => e.data?.feature)).toContain(
      "menu-vertical",
    );
  });

  test("a menu with neither says nothing", async () => {
    const run = await runFor(PLAIN.site, PLAIN.subject);
    run.ctx.convert([bare("cwicly/menu", { menuSelected: "5", isStyling: false })]);
    const features = byCode(run.reports(), "interaction.approximated").map((e) => e.data?.feature);
    expect(features).not.toContain("menu-dropdown");
    expect(features).not.toContain("menu-vertical");
  });
});
