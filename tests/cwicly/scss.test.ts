import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCwiclyCss } from "../../src/cwicly/css.ts";
import {
  compileScss,
  customCssSource,
  expandCustomCssTokens,
  usesScss,
} from "../../src/cwicly/scss.ts";
import type { WpBlock } from "../../src/types.ts";
import { walkBlocks } from "../../src/wp/blocks.ts";
import {
  allSubjects,
  loadSite,
  subjectBlocks,
  type LoadedSite,
  type SiteName,
} from "../helpers/ctx.ts";

const BREAKPOINTS = [
  { key: "lg", width: 1366, isMain: true, direction: "none" as const },
  { key: "md", width: 992, isMain: false, direction: "max" as const },
  { key: "sm", width: 576, isMain: false, direction: "max" as const },
];

const VARS = { classID: "div-c1", id: "div-1", breakpoints: BREAKPOINTS };

describe("expandCustomCssTokens (render.php's replacements)", () => {
  test("blockclass becomes the classID and blockid the id attribute", () => {
    expect(expandCustomCssTokens(".blockclass{a:b} #blockid .blockclass{c:d}", VARS)).toBe(
      ".div-c1{a:b} #div-1 .div-c1{c:d}",
    );
  });

  test("CR and LF are deleted, not turned into spaces, and runs of whitespace collapse", () => {
    // PHP: str_replace(["\r","\n"], '') then preg_replace('!\s+!', ' '). A line break between two
    // tokens glues them, which is what the live page gets.
    expect(expandCustomCssTokens(".a\n.b {\r\n    c: d;\r\n}", VARS)).toBe(".a.b { c: d;}");
    expect(expandCustomCssTokens("a  \t b", VARS)).toBe("a b");
  });

  test("breakpoint words become widths, the longer word first, and the main breakpoint is skipped", () => {
    expect(
      expandCustomCssTokens(
        "@media screen and (media-breakpoint-md){.x{width:breakpoint-md}} breakpoint-sm breakpoint-lg",
        VARS,
      ),
    ).toBe("@media screen and (max-width: 992px){.x{width:992px}} 576px breakpoint-lg");
  });

  test("a breakpoint listed before the main one is a min-width", () => {
    const vars = {
      ...VARS,
      breakpoints: [
        { key: "xl", width: 1600, isMain: false, direction: "min" as const },
        BREAKPOINTS[0]!,
      ],
    };
    expect(expandCustomCssTokens("@media (media-breakpoint-xl){}", vars)).toBe(
      "@media (min-width: 1600px){}",
    );
  });

  test("php: false keeps the newlines a // comment needs", () => {
    expect(expandCustomCssTokens("a // x\nb", VARS, { php: false })).toBe("a // x\nb");
  });
});

describe("customCssSource (which attribute render.php prints)", () => {
  test("customSCSS wins when the option is on and it is not empty", () => {
    expect(customCssSource({ customCSS: "a{}", customSCSS: "b{}" }, "true")).toEqual({
      source: "customSCSS",
      css: "b{}",
    });
  });

  test("customCSS is printed with the option off, or when there is no compiled text", () => {
    expect(customCssSource({ customCSS: "a{}", customSCSS: "b{}" }, undefined)?.source).toBe(
      "customCSS",
    );
    expect(customCssSource({ customCSS: "a{}", customSCSS: "b{}" }, "0")?.source).toBe("customCSS");
    expect(customCssSource({ customCSS: "a{}", customSCSS: "" }, "true")?.source).toBe("customCSS");
  });

  test("a stored 'false' is on, as PHP reads it", () => {
    expect(customCssSource({ customCSS: "a{}", customSCSS: "b{}" }, "false")?.source).toBe(
      "customSCSS",
    );
  });

  test("nothing is printed without customCSS, whatever customSCSS holds (render.php tests customCSS first)", () => {
    expect(customCssSource({ customSCSS: "b{}" }, "true")).toBeUndefined();
    expect(customCssSource({ customCSS: "", customSCSS: "b{}" }, "true")).toBeUndefined();
    expect(customCssSource({ customCSS: "0" }, "true")).toBeUndefined();
  });
});

describe("compileScss", () => {
  test("plain CSS passes through, one rule per selector", () => {
    const out = compileScss(".a{color:red}.b{margin:0}");
    expect(out.css).toBe(".a{color:red;}\n.b{margin:0;}");
    expect(out.unsupported).toEqual([]);
  });

  test("nesting flattens with a descendant, and & stands for the parent in any position", () => {
    const out = compileScss(`
      .a {
        color: red;
        .b { color: blue; }
        > .c { color: green; }
        &:hover { color: pink; }
        &.on { color: gold; }
        &-suffix { color: tan; }
        .x & { color: navy; }
        & + & { margin: 0; }
      }`);
    expect(out.css.split("\n")).toEqual([
      ".a{color:red;}",
      ".a .b{color:blue;}",
      ".a > .c{color:green;}",
      ".a:hover{color:pink;}",
      ".a.on{color:gold;}",
      ".a-suffix{color:tan;}",
      ".x .a{color:navy;}",
      ".a + .a{margin:0;}",
    ]);
  });

  test("a selector list multiplies across its parent's list", () => {
    expect(compileScss(".a, .b { .c, .d { x: y } }").css).toBe(".a .c, .a .d, .b .c, .b .d{x:y;}");
  });

  test("declarations after a nested rule keep source order in a rule of their own", () => {
    expect(compileScss(".a { x: 1; .b { y: 2 } z: 3 }").css.split("\n")).toEqual([
      ".a{x:1;}",
      ".a .b{y:2;}",
      ".a{z:3;}",
    ]);
  });

  test("@media bubbles out of its rule at any depth", () => {
    const out = compileScss(
      `.a { color: red; @media screen and (max-width: 10px) { color: blue; .b { c: d } } }`,
    );
    expect(out.css.split("\n")).toEqual([
      ".a{color:red;}",
      "@media screen and (max-width: 10px){.a{color:blue;}}",
      "@media screen and (max-width: 10px){.a .b{c:d;}}",
    ]);
  });

  test("// comments end at the line, but not inside a string or url()", () => {
    const out = compileScss(
      `.a { content: "// not a comment"; background: url(http://x.test/y.png); // gone\n color: red; }`,
    );
    expect(out.css).toBe(
      '.a{content:"// not a comment";background:url(http://x.test/y.png);color:red;}',
    );
  });

  test("variables, defaults and interpolation", () => {
    const out = compileScss(
      `$gap: 1rem; $gap: 9rem !default; $n: foo; .a-#{$n} { margin: $gap; padding: $gap $gap }`,
    );
    expect(out.css).toBe(".a-foo{margin:1rem;padding:1rem 1rem;}");
  });

  test("mixins with parameters, defaults, and keyword arguments", () => {
    const out = compileScss(
      `@mixin pad($x, $y: 2px) { padding: $y $x; } .a { @include pad(4px); } .b { @include pad($y: 1px, $x: 3px); }`,
    );
    expect(out.css.split("\n")).toEqual([".a{padding:2px 4px;}", ".b{padding:1px 3px;}"]);
  });

  test("@keyframes and @font-face are kept whole", () => {
    const out = compileScss(
      "@keyframes spin { from { opacity: 0 } to { opacity: 1 } } @font-face { font-family: x; src: url(a.woff2) }",
    );
    expect(out.css.split("\n")).toEqual([
      "@keyframes spin{from{opacity:0}to{opacity:1}}",
      "@font-face{font-family:x;src:url(a.woff2);}",
    ]);
  });

  test("what the subset does not read is reported and left out, never guessed", () => {
    const features = (source: string): string[] =>
      compileScss(source).unsupported.map((p) => p.feature);
    expect(features(".a { @extend .b; }")).toContain("@extend");
    expect(features(".a { @if $x { y: z } }")).toContain("@if");
    expect(features("@each $x in a, b { .#{$x} { y: z } }")).toContain("@each");
    expect(features("@function f($x) { @return $x; }")).toContain("@function");
    expect(features("@use 'x';")).toContain("@use");
    expect(features("%p { a: b } .c { d: e }")).toContain("%placeholder");
    expect(features(".a { margin: { top: 1px } }")).toContain("nested properties");
    expect(features("$g: 1px; .a { margin: $g * 2 }")).toContain("arithmetic");
    expect(features(".a { color: darken(#fff, 10%) }")).toContain("function");
    expect(features(".a { @include nothing; }")).toContain("@include");
    expect(features(".a { color: $nope }")).toContain("variable");
    const out = compileScss("$g: 1px; .a { margin: $g * 2; color: red }");
    expect(out.css).toBe(".a{color:red;}");
  });

  test("nesting deeper than 64 levels stops with a report instead of recursing forever", () => {
    const source = `${".a {".repeat(70)} x: y ${"}".repeat(70)}`;
    const out = compileScss(source);
    expect(out.unsupported.some((p) => p.feature === "nesting")).toBe(true);
  });

  test("the output is something the CSS reader takes: nested rules land on the classID", () => {
    const text = compileScss(
      `.div-c1 { color: red; &:hover { color: blue } .x { y: z } @media screen and (max-width: 992px) { color: pink } }`,
    ).css;
    const index = parseCwiclyCss(text, BREAKPOINTS);
    expect(index.classes.get("div-c1")?.style).toEqual({
      color: "red",
      ":hover": { color: "blue" },
      "& .x": { y: "z" },
      "@--md": { color: "pink" },
    });
  });
});

describe("usesScss", () => {
  test("answers true for the constructs only Sass reads, false for CSS (native nesting included)", () => {
    expect(usesScss("$a: 1;")).toBe(true);
    expect(usesScss(".a { color: $a }")).toBe(true);
    expect(usesScss("@mixin x { }")).toBe(true);
    expect(usesScss(".a-#{$b} { }")).toBe(true);
    expect(usesScss("%placeholder { }")).toBe(true);
    expect(usesScss(".a { &:hover { color: red } }")).toBe(false);
    expect(usesScss(".a { color: red }")).toBe(false);
    expect(usesScss("/* $a: 1 */ .a { color: red }")).toBe(false);
    // Sass interpolates only `#{…}` inside a string, so a `$` there is text (a price, a currency).
    expect(usesScss('.a::before { content: "$x" }')).toBe(false);
  });

  test("a $word inside a string or a url() is text, so plain CSS with a price in it is not SCSS", () => {
    expect(usesScss('.blockclass::before{content:"$5"}')).toBe(false);
    expect(usesScss(".a { content: '$5 off'; --price: \"$5\" }")).toBe(false);
    expect(usesScss('a[href$=pdf]::after{content:"$x"}')).toBe(false);
    expect(usesScss(".a { background: url(img/$x.png) }")).toBe(false);
    expect(usesScss('.a::before { content: "#{$x}" }')).toBe(true);
  });

  test("a plain @import (url() or a .css file) is CSS; a Sass partial is not", () => {
    expect(usesScss("@import url(https://fonts.test/a.css); .a{color:red}")).toBe(false);
    expect(usesScss('@import "a.css"; .a{color:red}')).toBe(false);
    expect(usesScss("@import 'https://fonts.test/a'; .a{color:red}")).toBe(false);
    expect(usesScss("@import 'partial'; .a{color:red}")).toBe(true);
  });

  test("a // comment is SCSS (it is what the compile path was written for), but not inside a string or url()", () => {
    expect(usesScss("// make it red\n.blockclass{color:red}")).toBe(true);
    expect(usesScss(".blockclass{\n  // inner\n  color:red;\n}")).toBe(true);
    expect(usesScss(".a{background:url(//cdn.test/y.png)}")).toBe(false);
    expect(usesScss('.a{content:"//"}')).toBe(false);
    expect(usesScss("/* // */ .a{color:red}")).toBe(false);
  });
});

describe("compileScss: what Sass leaves alone", () => {
  test("a $word inside a quoted string stays text, even when a variable of that name exists", () => {
    expect(compileScss('.a:after{content:"$5";color:red}')).toEqual({
      css: '.a:after{content:"$5";color:red;}',
      unsupported: [],
    });
    expect(compileScss('$price: 9; .a::after{content:"$price"; color: red}')).toEqual({
      css: '.a::after{content:"$price";color:red;}',
      unsupported: [],
    });
    expect(compileScss(".a{--price:'$5 off';display:block}").unsupported).toEqual([]);
  });

  test("#{…} inside a string is still interpolation", () => {
    expect(compileScss('$n: 5; .a::after{content:"#{$n}"}').css).toBe('.a::after{content:"5";}');
  });

  test("the CSS filter functions are CSS, not Sass colour functions", () => {
    const out = compileScss(
      "$c: red; .a{color:$c; filter: grayscale(100%) invert(1) saturate(150%)}",
    );
    expect(out).toEqual({
      css: ".a{color:red;filter:grayscale(100%) invert(1) saturate(150%);}",
      unsupported: [],
    });
    expect(compileScss(".a{filter:grayscale(var(--g)) invert(calc(1 - var(--x)))}").css).not.toBe(
      "",
    );
  });

  test("the Sass forms of those names (a colour argument) are still reported", () => {
    const features = (source: string): string[] =>
      compileScss(source).unsupported.map((p) => p.feature);
    expect(features(".a{color:grayscale(#ff0000)}")).toContain("function");
    expect(features(".a{color:invert(red, 50%)}")).toContain("function");
    expect(features("$c: red; .a{color:saturate($c, 20%)}")).toContain("function");
    expect(features(".a{color:opacify(red, .2)}")).toContain("function");
  });

  test("arithmetic on literals is reported and left out, not printed as invalid CSS; calc() is CSS", () => {
    const out = compileScss(
      "$c: red; .a{width: 10px + 5px; height:(10px * 2); margin: 4px - 1px; color:$c; padding: calc(10px + 5px); font: 12px/1.5 a; aspect-ratio: 16/9; margin-top: -4px}",
    );
    expect(out.unsupported.filter((p) => p.feature === "arithmetic").length).toBe(3);
    expect(out.css).toBe(
      ".a{color:red;padding:calc(10px + 5px);font:12px/1.5 a;aspect-ratio:16/9;margin-top:-4px;}",
    );
  });
});

// ── Real data ────────────────────────────────────────────────────────────────────────────────────

const SITES: SiteName[] = ["fineline", "ap"];
const loaded = new Map<SiteName, LoadedSite>();
/** Every block with custom CSS, by site. */
const withCustom: { site: SiteName; block: WpBlock }[] = [];
const byId = new Map<string, WpBlock>();

beforeAll(async () => {
  for (const name of SITES) {
    const site = await loadSite(name);
    loaded.set(name, site);
    for (const subject of allSubjects(site)) {
      walkBlocks(subjectBlocks(site, subject), (block) => {
        if (typeof block.attrs.id === "string") byId.set(`${name}:${block.attrs.id}`, block);
        const css = block.attrs.customCSS;
        const scss = block.attrs.customSCSS;
        if ((typeof css === "string" && css.trim()) || (typeof scss === "string" && scss.trim())) {
          withCustom.push({ site: name, block });
        }
      });
    }
  }
});

describe("real custom CSS", () => {
  test("the census: 33 blocks across both sites, none of it SCSS-only, so nothing needs a compile", () => {
    const counts = SITES.map((s) => withCustom.filter((w) => w.site === s).length);
    expect(counts).toEqual([1, 32]);
    for (const { block } of withCustom) {
      for (const key of ["customCSS", "customSCSS"] as const) {
        const text = block.attrs[key];
        if (typeof text === "string") expect(usesScss(text)).toBe(false);
      }
    }
  });

  test("every real value compiles to itself: the SCSS compiler changes no rule of any of them", () => {
    for (const { site, block } of withCustom) {
      const options = loaded.get(site)!;
      const source = customCssSource(
        block.attrs,
        options.model.options.get("cwicly_scss_compiler"),
      );
      if (!source) continue;
      const vars = {
        classID: String(block.attrs.classID),
        id: String(block.attrs.id),
        breakpoints: options.options.breakpoints,
      };
      const text = expandCustomCssTokens(source.css, vars);
      const a = parseCwiclyCss(text, options.options.breakpoints);
      const b = parseCwiclyCss(compileScss(text).css, options.options.breakpoints);
      expect(Object.fromEntries(b.classes)).toEqual(Object.fromEntries(a.classes));
      expect(Object.fromEntries(b.other)).toEqual(Object.fromEntries(a.other));
      expect(b.atRules).toEqual(a.atRules);
    }
  });

  test("where a block has both attributes, the editor's compiled text and the source read the same", () => {
    const both = withCustom.filter(
      ({ block }) =>
        typeof block.attrs.customCSS === "string" &&
        block.attrs.customCSS.trim() &&
        typeof block.attrs.customSCSS === "string" &&
        block.attrs.customSCSS.trim(),
    );
    expect(both.length).toBe(5);
    for (const { site, block } of both) {
      const options = loaded.get(site)!;
      const vars = {
        classID: String(block.attrs.classID),
        id: String(block.attrs.id),
        breakpoints: options.options.breakpoints,
      };
      const read = (text: string) =>
        parseCwiclyCss(expandCustomCssTokens(text, vars), options.options.breakpoints);
      const written = read(block.attrs.customCSS as string);
      const compiled = read(block.attrs.customSCSS as string);
      expect(Object.fromEntries(compiled.classes)).toEqual(Object.fromEntries(written.classes));
    }
  });

  test("the live pages print exactly what expandCustomCssTokens makes of the attribute (every <style id=custom-css-…> of both sites)", () => {
    let checked = 0;
    for (const name of SITES) {
      const options = loaded.get(name)!;
      const dir = join(import.meta.dir, "../fixtures", name, "html");
      const seen = new Set<string>();
      for (const file of readdirSync(dir)) {
        const html = readFileSync(join(dir, file), "utf8");
        for (const match of html.matchAll(/<style id="custom-css-([^"]*)">([^<]*)<\/style>/g)) {
          const [, id, printed] = match;
          const key = `${id}|${printed}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const block = byId.get(`${name}:${id}`);
          expect(block, `a block with id ${id}`).toBeDefined();
          const source = customCssSource(
            block!.attrs,
            options.model.options.get("cwicly_scss_compiler"),
          );
          expect(source).toBeDefined();
          const mine = expandCustomCssTokens(source!.css, {
            classID: String(block!.attrs.classID),
            id: String(block!.attrs.id),
            breakpoints: options.options.breakpoints,
          });
          expect(mine).toBe(printed!);
          checked++;
        }
      }
    }
    expect(checked).toBe(6);
  });
});
