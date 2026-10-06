import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { camelToKebab, cssPropertyName } from "@jxsuite/runtime/css";
import { validateDocument } from "@jxsuite/schema";
import { parse as parseBlocks } from "@wordpress/block-serialization-default-parser";
import postcss from "postcss";
import {
  CSS_ARTIFACT,
  classifySelector,
  cssRules,
  emptyCssIndex,
  jxStyleKey,
  loadCssIndex,
  mergeCssIndexes,
  parseCwiclyCss,
  projectStyles,
} from "../../src/cwicly/css.ts";
import type { OrderedCssIndex } from "../../src/cwicly/css.ts";
import type { Breakpoint, CssIndex, CssSource, JxStyle } from "../../src/types.ts";
import {
  analysedRulesOf,
  canonicalCss,
  canonicalDiff,
  cascadeDiff,
  cascadeOf,
  classSelector,
  discardedByBrowsers,
  flattenCanonical,
  renderCascade,
  renderCssIndex,
  renderProjectStyle,
} from "../helpers/css-oracle.ts";
import {
  FIXTURE_BREAKPOINTS,
  FIXTURE_SITES,
  fixtureCssNames,
  fixtureCssSource,
  fixtureOptionCss,
  readFixtureCss,
} from "../helpers/fixture-css.ts";
import { fixtureDir, readFixtureJson, readFixtureText } from "../helpers/fixture-db.ts";

// Cascade checks over every block of every post take seconds, and a loaded machine doubles them.
setDefaultTimeout(60_000);

const BPS = FIXTURE_BREAKPOINTS;
const parse = (css: string, breakpoints: Breakpoint[] = BPS): OrderedCssIndex =>
  parseCwiclyCss(css, breakpoints);

/** Memoise by CSS text: the corpus is parsed and canonicalised by many tests, and none of them writes to the result. */
const memo = <V>(compute: (css: string) => V): ((css: string) => V) => {
  const cache = new Map<string, V>();
  return (css) => {
    if (!cache.has(css)) cache.set(css, compute(css));
    return cache.get(css)!;
  };
};
const parsed = memo((css) => parse(css));
const canonicalOf = memo((css) => canonicalCss(css, BPS));
const roundTripped = memo((css) => canonicalCss(renderCssIndex(parsed(css), BPS)));
const styleOf = (index: CssIndex, name: string): JxStyle | undefined =>
  index.classes.get(name)?.style;
const codesOf = (index: CssIndex): string[] => index.artifacts.map((artifact) => artifact.code);
const countBy = (index: CssIndex): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const artifact of index.artifacts) counts[artifact.code] = (counts[artifact.code] ?? 0) + 1;
  return counts;
};
const isBlock = (value: unknown): value is JxStyle =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every key in a style, with the path of block keys that leads to it. */
function walkKeys(
  style: JxStyle,
  visit: (key: string, value: unknown, path: string[]) => void,
  path: string[] = [],
): void {
  for (const [key, value] of Object.entries(style)) {
    visit(key, value, path);
    if (isBlock(value)) walkKeys(value, visit, [...path, key]);
  }
}

function everyStyle(index: CssIndex): JxStyle[] {
  return [
    ...[...index.classes.values()].map((entry) => entry.style),
    ...index.other.values(),
    ...index.atRules.map((rule) => rule.style),
  ];
}

/** A source over an in-memory map that records what it was asked for. */
function memorySource(files: Record<string, string>): CssSource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async get(name) {
      asked.push(name);
      return files[name] ?? null;
    },
  };
}

// ── The real corpus ──────────────────────────────────────────────────────────────────────────────

interface RealFile {
  site: string;
  name: string;
  css: string;
}

const REAL: RealFile[] = FIXTURE_SITES.flatMap((site) =>
  fixtureCssNames(site).map((name) => ({ site, name, css: readFixtureCss(site, name) })),
);

/** The compiled-CSS options the options module hands over as strings. */
const OPTION_CSS: RealFile[] = FIXTURE_SITES.flatMap((site) =>
  ["cwicly_global_css", "cwicly_global_stylesheets_rendered"].flatMap((option) => {
    const css = fixtureOptionCss(site, option);
    return css === null ? [] : [{ site, name: `option:${option}`, css }];
  }),
);

/**
 * The distinct inline `<style>` blocks of the rendered pages: Cwicly's own `cc-global-inline-css`
 * (the global CSS option again) and WordPress's core block styles. They are real CSS of a shape the
 * generated files do not have (`:root :where(…)`, `@charset`, comments, plain `max-width: 600px` queries).
 */
const INLINE_CSS: RealFile[] = (() => {
  const seen = new Set<string>();
  const blocks: RealFile[] = [];
  for (const site of FIXTURE_SITES) {
    for (const file of readdirSync(join(fixtureDir(site), "html")).sort()) {
      const html = readFixtureText(site, `html/${file}`);
      for (const match of html.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/g)) {
        const css = match[2]!.trim();
        if (css === "" || seen.has(css)) continue;
        seen.add(css);
        const id = /id=["']([^"']+)["']/.exec(match[1]!)?.[1] ?? "style";
        blocks.push({ site, name: `html/${file}#${id}`, css });
      }
    }
  }
  return blocks;
})();

describe("the fixture corpus is what these tests were written against", () => {
  test("105 fineline and 50 ap stylesheets", () => {
    expect(fixtureCssNames("fineline")).toHaveLength(105);
    expect(fixtureCssNames("ap")).toHaveLength(50);
    expect(REAL).toHaveLength(155);
  });

  test("and 34 distinct inline style blocks in the rendered pages, 3 compiled-CSS options", () => {
    expect(INLINE_CSS).toHaveLength(34);
    expect(OPTION_CSS.map((entry) => `${entry.site}/${entry.name}`)).toEqual([
      "fineline/option:cwicly_global_css",
      "ap/option:cwicly_global_css",
      "ap/option:cwicly_global_stylesheets_rendered",
    ]);
  });
});

describe("round-trip oracle: canonical(original minus artifacts) == canonical(render(parse(original)))", () => {
  for (const { site, name, css } of [...REAL, ...OPTION_CSS, ...INLINE_CSS]) {
    test(`${site}/${name}`, () => {
      const index = parsed(css);
      const original = canonicalOf(css);
      const rendered = roundTripped(css);
      // Differences first, as readable lines, then the structures themselves.
      expect(canonicalDiff(original, rendered)).toEqual([]);
      expect(rendered.rules).toEqual(original.rules);
      expect(rendered.atRules).toEqual(original.atRules);
      // What the reader reports is exactly what the oracle had to remove, code by code.
      expect(countBy(index)).toEqual(original.artifacts);
    });
  }

  test("and the comparison is not vacuous: the canonical forms hold what the files say", () => {
    const totals = {
      fineline: { declarations: 0, selectors: 0 },
      ap: { declarations: 0, selectors: 0 },
    };
    for (const { site, css } of REAL) {
      const canonical = canonicalOf(css);
      totals[site as "fineline" | "ap"].declarations += flattenCanonical(canonical).length;
      totals[site as "fineline" | "ap"].selectors += Object.keys(canonical.rules).length;
    }
    // The canonical forms leave out what the generator got wrong and what a browser would discard:
    // the same declarations (51 of them in these files) and the three `.` rules the corpus holds.
    expect(totals).toEqual({
      fineline: { declarations: 25824, selectors: 5208 },
      ap: { declarations: 4645, selectors: 1295 },
    });
  });

  test("the same rules, emitted the way project.json `style` is emitted by the build", () => {
    // `buildSiteStyleCSS` is what the compiler writes every page's project style with.
    for (const { site, name, css } of [...REAL, ...OPTION_CSS, ...INLINE_CSS]) {
      const expected = canonicalOf(css);
      const actual = canonicalCss(renderProjectStyle(parsed(css), BPS));
      expect({
        file: `${site}/${name}`,
        diff: canonicalDiff(expected, { ...actual, atRules: expected.atRules }),
      }).toEqual({
        file: `${site}/${name}`,
        diff: [],
      });
    }
  });

  describe("negative controls: the oracle is not vacuous", () => {
    const css = readFixtureCss("fineline", "cc-global-classes.css");
    const original = canonicalCss(css);
    const diffAfter = (mutate: (index: CssIndex) => void): string[] => {
      const index = mergeCssIndexes(parse(css));
      mutate(index);
      return canonicalDiff(original, canonicalCss(renderCssIndex(index, BPS)));
    };

    test("an untouched index passes", () => {
      expect(diffAfter(() => {})).toEqual([]);
    });
    test("a lost declaration is noticed", () => {
      expect(
        diffAfter((index) => delete index.classes.get("paragraph-bold")!.style["fontWeight"]),
      ).not.toEqual([]);
    });
    test("a changed value is noticed", () => {
      expect(
        diffAfter((index) => (index.classes.get("paragraph-bold")!.style["fontWeight"] = "100")),
      ).not.toEqual([]);
    });
    test("a breakpoint moved to another is noticed", () => {
      expect(
        diffAfter((index) => {
          const style = index.classes.get("paragraph-large")!.style;
          style["@--sm"] = style["@--md"]!;
          delete style["@--md"];
        }),
      ).not.toEqual([]);
    });
    test("a descendant turned into a child is noticed", () => {
      expect(
        diffAfter((index) => {
          const style = index.classes.get("icon-large")!.style;
          style["& > svg"] = style["& svg"]!;
          delete style["& svg"];
        }),
      ).not.toEqual([]);
    });
    test("a lost !important is noticed", () => {
      expect(
        diffAfter((index) => {
          const style = index.classes.get("image-background")!.style;
          style["height"] = "100%";
        }),
      ).not.toEqual([]);
    });
    test("a lost class is noticed", () => {
      expect(
        diffAfter((index) => (index.classes as Map<string, unknown>).delete("card-default")),
      ).not.toEqual([]);
    });
    test("a lost `other` entry is noticed", () => {
      expect(diffAfter((index) => (index.other as Map<string, unknown>).clear())).not.toEqual([]);
    });
    test("a wrong pseudo-element is noticed", () => {
      expect(
        diffAfter((index) => {
          const style = index.classes.get("section-hero")!.style;
          style["::after"] = style["::before"]!;
          delete style["::before"];
        }),
      ).not.toEqual([]);
    });
  });
});

describe("shape of every parsed style, over the whole corpus", () => {
  const breakpointKeys = new Set(BPS.filter((bp) => !bp.isMain).map((bp) => `@--${bp.key}`));
  const originalProperties = (css: string): Set<string> => {
    const properties = new Set<string>();
    postcss.parse(css).walkDecls((declaration) => {
      properties.add(
        declaration.prop.startsWith("--") ? declaration.prop : declaration.prop.toLowerCase(),
      );
    });
    return properties;
  };

  for (const { site, name, css } of [...REAL, ...OPTION_CSS]) {
    test(`${site}/${name}`, () => {
      const index = parsed(css);
      const properties = originalProperties(css);
      for (const style of everyStyle(index)) {
        walkKeys(style, (key, value, path) => {
          if (key.startsWith("@")) {
            // Only declared breakpoints, or the at-rules a real file nests (`@supports` in the options).
            expect(breakpointKeys.has(key) || key.startsWith("@supports ")).toBe(true);
            expect(isBlock(value)).toBe(true);
          } else if (/^[:&.[]/.test(key)) {
            expect(isBlock(value)).toBe(true);
          } else if (key.startsWith("--")) {
            expect(typeof value).toBe("string");
            expect(properties.has(key)).toBe(true);
          } else {
            expect(key).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
            expect(typeof value).toBe("string");
            // The real Jx inverse gives back a property that was in the file.
            expect(properties.has(cssPropertyName(key))).toBe(true);
            expect(camelToKebab(key)).toBe(cssPropertyName(key));
          }
          if (typeof value === "string") {
            expect(value).not.toContain("!var=");
            expect(value).not.toContain("[object Object]");
            expect(value).not.toMatch(/(?<![\w-])undefined/);
            expect(value).toBe(value.trim());
          }
          expect(path.filter((segment) => segment.startsWith("@")).length).toBeLessThanOrEqual(2);
        });
      }
    });
  }

  test("the styles are what Jx's own document schema accepts (the validation `jx validate` runs)", async () => {
    // One element per class and per `other` rule, from the merged index of each site, as a page would carry them.
    // The first is a control with a style value of the wrong type: the validator must refuse it, and nothing else.
    const children: object[] = [{ tagName: "div", style: { color: true } }];
    for (const site of FIXTURE_SITES) {
      const merged = mergeCssIndexes(
        ...REAL.filter((file) => file.site === site).map((file) => parsed(file.css)),
      );
      for (const [name, entry] of merged.classes) {
        children.push({ tagName: "div", className: name, style: entry.style });
      }
      for (const style of merged.other.values()) children.push({ tagName: "div", style });
    }
    expect(children.length).toBeGreaterThan(1500);
    const verdict = await validateDocument({ tagName: "div", children });
    expect(verdict.valid).toBe(false);
    const errors = (verdict.errors ?? []) as { instancePath: string }[];
    expect(errors.length).toBeGreaterThan(0);
    // Every complaint is about the control: child 0, or the `children` list that child 0 spoils.
    const unrelated = errors.filter(
      (error) => !/^\/children(\/0(\/|$)|$)/.test(error.instancePath),
    );
    expect(unrelated).toEqual([]);
  }, 60_000);

  test("every `@--` key anywhere in the corpus names a declared breakpoint", () => {
    const seen = new Set<string>();
    for (const { css } of [...REAL, ...OPTION_CSS]) {
      for (const style of everyStyle(parsed(css))) {
        walkKeys(style, (key) => {
          if (key.startsWith("@--")) seen.add(key);
        });
      }
    }
    expect([...seen].sort()).toEqual(["@--md", "@--sm"]);
  });
});

describe("artifacts over the whole corpus", () => {
  const totals: Record<string, number> = {};
  for (const { css } of REAL) {
    for (const [code, count] of Object.entries(countBy(parsed(css))))
      totals[code] = (totals[code] ?? 0) + count;
  }

  test("the palette-variable count equals an independent count of `!var=` in the same files", () => {
    const independent = REAL.reduce((sum, { css }) => sum + (css.match(/!var=/g) ?? []).length, 0);
    expect(totals[CSS_ARTIFACT.unresolvedPaletteVar]).toBe(independent);
    expect(independent).toBe(1);
    for (const { css } of REAL) {
      const found = (css.match(/!var=/g) ?? []).length;
      expect(countBy(parsed(css))[CSS_ARTIFACT.unresolvedPaletteVar] ?? 0).toBe(found);
    }
  });

  test("the generator's other artifacts, counted independently of the reader", () => {
    const count = (pattern: RegExp): number =>
      REAL.reduce((sum, { css }) => sum + (css.match(pattern) ?? []).length, 0);
    const objectValues = count(/\[object Object\]/g);
    // `polygon(undefined% undefined%,…)` is written twice per rule (prefixed and not).
    const undefinedValues = count(/\(undefined%/g);
    // A template variable that was empty: `column-gap:  ;` (with its `-moz-` twin), `background-image: ;`.
    const emptyValues = count(/(?<![\w-])(?:column-gap|background-image|-moz-column-gap)\s*:\s*;/g);
    // `repeat(auto-fit, minmax(, 1fr))`: the first argument of `minmax` was empty.
    const emptyArguments = count(/minmax\(\s*,/g);
    // `padding: 0px!important 2px !important`: two values, the first marked important.
    const importantInMiddle = count(/!\s*important\s+[^\s;}]/g);
    expect(objectValues).toBe(63);
    expect(undefinedValues).toBe(24);
    expect(emptyValues).toBe(35);
    expect(emptyArguments).toBe(14);
    expect(importantInMiddle).toBe(2);
    expect(totals[CSS_ARTIFACT.invalidValue]).toBe(
      objectValues + undefinedValues + emptyValues + emptyArguments + importantInMiddle,
    );
    // `.undefined{}` and `undefined…` in a list (96), and the four `.` rules of an empty classID.
    expect(totals[CSS_ARTIFACT.undefinedSelector]).toBe(100);
  });

  test("nothing else is reported: every selector, query and at-rule in the corpus is understood", () => {
    expect(totals).toEqual({
      [CSS_ARTIFACT.unresolvedPaletteVar]: 1,
      [CSS_ARTIFACT.undefinedSelector]: 100,
      [CSS_ARTIFACT.invalidValue]: 138,
    });
  });

  test("the palette artifact names the palette id, the property and the rule", () => {
    const index = parse(readFixtureCss("ap", "cc-global-classes.css"));
    expect(index.artifacts.filter((a) => a.code === CSS_ARTIFACT.unresolvedPaletteVar)).toEqual([
      {
        code: "css.unresolved-palette-var",
        selector: ".searchform:hover .cc-icn svg path",
        detail: 'fill: the generator left the palette reference "9d4k1" unresolved',
      },
    ]);
    expect(JSON.stringify(styleOf(index, "searchform"))).not.toContain("path");
  });

  test("`undefined` selectors are dropped member by member, keeping their valid neighbours", () => {
    const index = parse(readFixtureCss("ap", "cc-tp-cwicly_header.css"));
    expect(
      index.artifacts
        .filter((a) => a.code === CSS_ARTIFACT.undefinedSelector)
        .map((a) => a.selector),
    ).toContain("undefinedsection-c0c88bd p");
    // `.section-c0c88bd a, undefinedsection-c0c88bd p, …{color}`: the first member is real.
    expect(styleOf(index, "section-c0c88bd")?.["& a"]).toEqual({ color: "var(--cc-color-5)" });
    expect(index.other.has("undefinedsection-c0c88bd p")).toBe(false);
    expect([...index.other.keys()].some((key) => key.includes("undefined"))).toBe(false);
    expect([...index.classes.keys()].some((key) => key.includes("undefined"))).toBe(false);
  });

  test("90 of the 96 `undefined` selectors are empty rules, and the report says so; 6 had declarations", () => {
    let empty = 0;
    let withDeclarations = 0;
    for (const { css } of REAL) {
      for (const artifact of parsed(css).artifacts) {
        if (artifact.code !== CSS_ARTIFACT.undefinedSelector) continue;
        if (!artifact.detail.includes('contains "undefined"')) continue;
        if (artifact.detail.endsWith("and the rule is empty")) empty += 1;
        else withDeclarations += 1;
      }
    }
    expect({ empty, withDeclarations }).toEqual({ empty: 90, withDeclarations: 6 });
    const header = parse(readFixtureCss("ap", "cc-tp-cwicly_header.css"));
    expect(header.artifacts.find((a) => a.selector === "undefinedsection-c0c88bd p")?.detail).toBe(
      'selector "undefinedsection-c0c88bd p" contains "undefined"',
    );
  });

  test("the `.undefined{}` rules are reported but leave no class behind", () => {
    const index = parse(readFixtureCss("fineline", "cc-post-1013.css"));
    expect(index.classes.has("undefined")).toBe(false);
    expect(codesOf(index)).toContain(CSS_ARTIFACT.undefinedSelector);
  });

  test("a clip-path whose polygon coordinates were never set is dropped, prefixed twin included, the rest of the class stays", () => {
    const index = parse(readFixtureCss("fineline", "cc-post-5278.css"));
    // .div-c4fc01f{-webkit-clip-path:polygon(undefined% …);clip-path:polygon(undefined% …)} then
    // .div-c4fc01f{background-image:url(…);position:relative;padding-right:40px;padding-left:40px}
    expect(styleOf(index, "div-c4fc01f")).toEqual({
      backgroundImage:
        "url(https://finelinepainting.pro/wp-content/uploads/swash-light-gray-vertical-flip-optimized.svg)",
      position: "relative",
      paddingRight: "40px",
      paddingLeft: "40px",
    });
    expect(
      index.artifacts.filter(
        (a) => a.code === CSS_ARTIFACT.invalidValue && a.selector === ".div-c4fc01f",
      ),
    ).toHaveLength(2);
  });
});

describe("selector census of the corpus", () => {
  test("every selector is classified, and the counts are the ones the module header states", () => {
    const counts = {
      files: 0,
      rules: 0,
      declarations: 0,
      selectors: 0,
      classAlone: 0,
      classPseudo: 0,
      descendant: 0,
      child: 0,
      tagQualified: 0,
      other: 0,
      undefinedSelectors: 0,
      emptyClassSelectors: 0,
    };
    const otherSelectors = new Set<string>();
    for (const { css } of REAL) {
      counts.files += 1;
      postcss.parse(css).walk((node) => {
        if (node.type === "decl") counts.declarations += 1;
        if (node.type !== "rule") return;
        counts.rules += 1;
        for (const member of postcss.list
          .comma(node.selector)
          .map((m) => m.trim())
          .filter(Boolean)) {
          counts.selectors += 1;
          if (/(?<![\w-])undefined/.test(member)) {
            counts.undefinedSelectors += 1;
            continue;
          }
          // `.`: a block whose classID is empty. No class, so nowhere to put its declarations.
          if (member === ".") {
            counts.emptyClassSelectors += 1;
            expect(classifySelector(member)).toBeNull();
            continue;
          }
          const placement = classifySelector(member);
          expect(placement).not.toBeNull();
          if (placement!.kind === "other") {
            counts.other += 1;
            otherSelectors.add(placement!.selector);
          } else if (placement!.key === "") {
            counts.classAlone += 1;
          } else if (placement!.key.startsWith("&:is(")) {
            counts.tagQualified += 1;
          } else if (!placement!.key.startsWith("&")) {
            counts.classPseudo += 1;
          } else if (/^&\S* > /.test(placement!.key)) {
            counts.child += 1;
          } else {
            counts.descendant += 1;
          }
        }
      });
    }
    expect(counts).toEqual({
      files: 155,
      rules: 11370,
      declarations: 32095,
      selectors: 11484,
      classAlone: 9907,
      classPseudo: 63,
      descendant: 982,
      child: 372,
      tagQualified: 26,
      other: 34,
      undefinedSelectors: 96,
      emptyClassSelectors: 4,
    });
    expect([...otherSelectors].sort()).toEqual(
      [
        ".button-cb319fb.cs-bmuh8n",
        ".button-light.ff-btn",
        ".div-cf3ac5e.cs-bmuh8n",
        ".div-cf3ac5e.cs-kxrx4",
        ".give-donor-dashboard-button.give-donor-dashboard-button--primary",
        ".list-cba37af.cc-icon-list li::before",
        ".query-container.filter-visible .div-sidebar-container",
        ".query-container.filter-visible .query-episodes",
        ".query-container.filter-visible .query-posts",
        ".querytemplate-cf01409.cc-masonry",
        ".relevanssi-live-search-results.relevanssi-live-search-results-showing",
        ".relevanssi-live-search-results.relevanssi-live-search-results-showing a",
        ".wp-block-search.wp-block-search__button-inside .wp-block-search__inside-wrapper .wp-block-search__button",
        ":where(.nav-c0498d1 .cc-nav-toggle)",
        ":where(.nav-ce2259c .cc-nav-toggle)",
        ":where(.unknown-class .cc-nav-toggle)",
        "body",
        "fieldset#give_cc_fields",
        "fieldset#give_cc_fields #give_secure_site_wrapper",
        "fieldset#give_cc_fields .give-input",
        "fieldset#give_cc_fields legend",
        "fieldset#give_checkout_user_info",
        "ul#give-gateway-radio-list",
        "ul#give-gateway-radio-list li",
      ].sort(),
    );
  });

  test("the vendor-prefixed properties that survive are exactly the prefixed-only ones, and they round-trip through Jx", () => {
    const survivors = new Set<string>();
    for (const { css } of REAL) {
      for (const style of everyStyle(parsed(css))) {
        walkKeys(style, (key, value) => {
          if (typeof value === "string" && /^[A-Z]/.test(key)) survivors.add(key);
        });
      }
    }
    expect([...survivors].sort()).toEqual(["MozColumnBreakInside", "WebkitMaskPositionX"]);
    expect(camelToKebab("MozColumnBreakInside")).toBe("-moz-column-break-inside");
    expect(camelToKebab("WebkitMaskPositionX")).toBe("-webkit-mask-position-x");
  });

  test("every property name in the corpus has a Jx key that the real camelToKebab turns back into it", () => {
    const names = new Set<string>();
    for (const { css } of [...REAL, ...OPTION_CSS]) {
      postcss.parse(css).walkDecls((declaration) => {
        names.add(
          declaration.prop.startsWith("--") ? declaration.prop : declaration.prop.toLowerCase(),
        );
      });
    }
    expect(names.size).toBeGreaterThan(100);
    for (const name of names) {
      const key = jxStyleKey(name);
      expect(key).not.toBeNull();
      expect(cssPropertyName(key!)).toBe(name);
    }
  });
});

// ── Hand-checked: the Icon Card component stylesheet ─────────────────────────────────────────────

describe("fineline/cc-cm-0a275b695a.css (the Icon Card component)", () => {
  // Read from the raw text:
  //   .div-cf3ac5e.cs-bmuh8n{flex-basis:calc(33% - 3rem)} .div-cf3ac5e.cs-kxrx4{flex-basis:calc(50% - 2rem)}
  //   .div-cf3ac5e{align-items:center;row-gap:1rem;-moz-column-gap:1rem;column-gap:1rem;position:relative;display:flex;flex-direction:column}
  //   .image-cf6348e .heading-cc0e8b0 .paragraph-c5200ff .button-cb319fb.cs-bmuh8n{display:none} .button-cb319fb{…}
  //   @media 992: .div-cf3ac5e.cs-bmuh8n{flex-basis:calc(50% - 2rem)}   @media 576: both variants → 100%
  const index = parse(readFixtureCss("fineline", "cc-cm-0a275b695a.css"));

  test("one class entry per block, in order of first appearance", () => {
    expect([...index.classes.keys()]).toEqual([
      "div-cf3ac5e",
      "image-cf6348e",
      "heading-cc0e8b0",
      "paragraph-c5200ff",
      "button-cb319fb",
    ]);
  });

  test("the block's own declarations, autoprefixed -moz-column-gap collapsed into column-gap", () => {
    expect(styleOf(index, "div-cf3ac5e")).toEqual({
      alignItems: "center",
      rowGap: "1rem",
      columnGap: "1rem",
      position: "relative",
      display: "flex",
      flexDirection: "column",
    });
    expect(Object.keys(styleOf(index, "div-cf3ac5e")!)).toEqual([
      "alignItems",
      "rowGap",
      "columnGap",
      "position",
      "display",
      "flexDirection",
    ]);
    expect(styleOf(index, "image-cf6348e")).toEqual({
      position: "relative",
      display: "block",
      height: "auto",
      width: "100%",
    });
    expect(styleOf(index, "heading-cc0e8b0")).toEqual({ position: "relative", display: "block" });
    expect(styleOf(index, "paragraph-c5200ff")).toEqual({ position: "relative", display: "block" });
    expect(styleOf(index, "button-cb319fb")).toEqual({
      alignItems: "center",
      position: "relative",
      display: "flex",
      flexDirection: "row",
    });
  });

  test("component variants (two classes on one element) are keyed by their selector, breakpoints nested", () => {
    expect([...index.other.keys()]).toEqual([
      ".div-cf3ac5e.cs-bmuh8n",
      ".div-cf3ac5e.cs-kxrx4",
      ".button-cb319fb.cs-bmuh8n",
    ]);
    expect(index.other.get(".div-cf3ac5e.cs-bmuh8n")).toEqual({
      flexBasis: "calc(33% - 3rem)",
      "@--md": { flexBasis: "calc(50% - 2rem)" },
      "@--sm": { flexBasis: "100%" },
    });
    expect(index.other.get(".div-cf3ac5e.cs-kxrx4")).toEqual({
      flexBasis: "calc(50% - 2rem)",
      "@--sm": { flexBasis: "100%" },
    });
    expect(index.other.get(".button-cb319fb.cs-bmuh8n")).toEqual({ display: "none" });
  });

  test("no at-rules, no artifacts", () => {
    expect(index.atRules).toEqual([]);
    expect(index.artifacts).toEqual([]);
  });
});

// ── Hand-checked: the global classes stylesheet ──────────────────────────────────────────────────

describe("fineline/cc-global-classes.css", () => {
  const index = parse(readFixtureCss("fineline", "cc-global-classes.css"));

  test("28 classes, named exactly as written (case kept), in order of first appearance", () => {
    expect([...index.classes.keys()]).toEqual([
      "unknown-class",
      "icon-plan",
      "icon-white",
      "section-default",
      "button-default",
      "paragraph-bold",
      "text-white",
      "paragraph-underline",
      "section-hero",
      "image-background",
      "paragraph-large",
      "card-default",
      "image-cover",
      "icon-large",
      "icon-small",
      "div-image",
      "card-4-row",
      "card-2-row",
      "card-4-row-flip",
      "card-default-flip",
      "gallery-default",
      "filter-default",
      "link-white",
      "link-on-blue",
      "header-link-blue",
      "heading-default-30",
      "Heading-W-on-NB",
      "H3-W-on-NB-30pdng",
    ]);
  });

  test("a selector list gives every member the same declarations, each its own copy", () => {
    const heading = styleOf(index, "Heading-W-on-NB");
    const h3 = styleOf(index, "H3-W-on-NB-30pdng");
    const expected = {
      backgroundColor: "var(--cc-color-1)",
      color: "var(--color-7swv3)",
      paddingTop: "30px",
      paddingBottom: "30px",
    };
    expect(heading).toEqual(expected);
    expect(h3).toEqual(expected);
    expect(heading).not.toBe(h3);
  });

  test("button-default: :hover, !important kept, a descendant rule from a list member", () => {
    // .button-default:hover{filter:…}  .button-default{background-image:url(…);…;padding:0.5rem 2rem}
    // .button-default,.button-default a{color:var(--cc-color-background) !important}
    expect(styleOf(index, "button-default")).toEqual({
      ":hover": { filter: "contrast(99%)hue-rotate(103deg)saturate(111%)" },
      backgroundImage: "url(https://finelinepainting.pro/wp-content/uploads/swash.svg)",
      backgroundSize: "100% 100%",
      backgroundRepeat: "no-repeat",
      whiteSpace: "nowrap",
      padding: "0.5rem 2rem",
      color: "var(--cc-color-background) !important",
      "& a": { color: "var(--cc-color-background) !important" },
    });
  });

  test("section-default: a descendant rule, then breakpoints nested at the end", () => {
    expect(styleOf(index, "section-default")).toEqual({
      "& .cc-cntr": { position: "relative" },
      rowGap: "2rem",
      display: "flex",
      flexDirection: "column",
      paddingTop: "5rem",
      paddingBottom: "5rem",
      "@--md": {
        "& .cc-cntr": {
          justifyContent: "center",
          rowGap: "3rem",
          columnGap: "3rem",
          display: "flex",
          flexDirection: "row",
          flexWrap: "wrap",
        },
        paddingRight: "2rem",
        paddingLeft: "2rem",
      },
      "@--sm": { padding: "3rem 1rem" },
    });
  });

  test("section-hero: child combinator, tag-qualified (a.cls) as &:is(a), legacy :before as ::before", () => {
    const hero = styleOf(index, "section-hero")!;
    expect(hero).toEqual({
      "& > div:not(.block-list-appender)": {
        color: "var(--cc-color-background)",
        textAlign: "center",
        rowGap: "2rem",
        display: "flex",
        flexDirection: "column",
        padding: "8rem 4rem",
      },
      "&:is(a) > div:not(.block-list-appender)": { color: "var(--cc-color-background)" },
      "& :is(h1,h2,h3,h4,h5,h6)": {
        color: "var(--cc-color-background)",
        filter: "drop-shadow(0.1rem 0.1rem 0.1rem var(--cc-color-1))",
      },
      "& p": {
        color: "var(--cc-color-background)",
        filter: "drop-shadow(0.1rem 0.1rem 0.1rem var(--cc-color-1))",
      },
      "& a": {
        color: "var(--cc-color-background)",
        filter: "drop-shadow(0.1rem 0.1rem 0.1rem var(--cc-color-1))",
      },
      "&:is(a) :is(h1,h2,h3,h4,h5,h6)": { color: "var(--cc-color-background)" },
      overflow: "hidden",
      position: "relative",
      padding: "5rem 2rem",
      "::before": {
        position: "absolute",
        content: '""',
        top: "0",
        right: "0",
        left: "0",
        bottom: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        backgroundColor: "var(--cc-color-8)",
      },
      "@--md": {
        "& > div:not(.block-list-appender)": { paddingTop: "5rem", paddingBottom: "5rem" },
        paddingTop: "3rem",
        paddingBottom: "3rem",
      },
      "@--sm": { "& > div:not(.block-list-appender)": { padding: "4rem 1.5rem" } },
    });
    expect(Object.keys(hero)).not.toContain(":before");
  });

  test("card-default: values are kept verbatim (Calc, not calc), later breakpoints win nowhere they should not", () => {
    expect(styleOf(index, "card-default")).toEqual({
      "& img": { borderRadius: "0.3rem", height: "20rem", minHeight: "20rem", maxHeight: "20rem" },
      borderRadius: "0.3rem",
      alignItems: "center",
      justifyContent: "flex-start",
      flexBasis: "Calc(50% - 1.5rem)",
      rowGap: "1rem",
      display: "flex",
      flexDirection: "column",
      padding: "5rem",
      "@--md": { "& img": { width: "15rem" }, flexBasis: "calc(50% - 1.5rem)" },
      "@--sm": { flexBasis: "100%", padding: "1rem" },
    });
  });

  test("gallery-default: `>` and ` ` are different keys, and the [object Object] width is reported, not emitted", () => {
    expect(styleOf(index, "gallery-default")).toEqual({
      "& > .cc-gallery > figure": { borderRadius: "0.3rem", height: "20rem", width: "auto" },
      "& .cc-gallery": {
        gridTemplateColumns: "repeat(3,minmax(0,1fr))",
        columnGap: "1rem",
        rowGap: "1rem",
      },
      "@--md": {
        "& > .cc-gallery > figure": { height: "15rem", width: "auto" },
        "& > .cc-gallery": { display: "grid" },
        "& .cc-gallery": { gridTemplateColumns: "repeat(2,minmax(0,1fr))" },
      },
      "@--sm": { "& > .cc-gallery > figure": { height: "8rem", width: "auto" } },
    });
    expect(index.artifacts).toEqual([
      {
        code: "css.invalid-value",
        selector: ".gallery-default .cc-gutter-sizer",
        detail: 'width: invalid value "[object Object]px"',
      },
    ]);
  });

  test("image-background: -o- twins collapsed, !important kept", () => {
    expect(styleOf(index, "image-background")).toEqual({
      objectPosition: "center center",
      top: "0rem",
      left: "0rem",
      zIndex: "-1",
      position: "absolute",
      height: "100% !important",
      width: "100% !important",
      objectFit: "cover",
    });
  });

  test("unknown-class: the doubled-parenthesis :is((h1,…)) is carried as written, a breakpoint-first rule nests first", () => {
    expect(styleOf(index, "unknown-class")).toEqual({
      "@--md": {
        "& .cc-nav-toggle:not(.cc-hamburger)": {
          height: "48px",
          width: "48px",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
        },
      },
      "& :is((h1,h2,h3,h4,h5,h6))": { color: "var(--cc-color-1)" },
      "& p": { color: "var(--cc-color-1)" },
      "& a": { color: "var(--cc-color-1)" },
      "&:is(a) :is((h1,h2,h3,h4,h5,h6))": { color: "var(--cc-color-1)" },
      "& :is((h1,h2,h3,h4,h5,h6)):hover": { color: "var(--cc-color-2)" },
      "& p:hover": { color: "var(--cc-color-2)" },
      "& a:hover": { color: "var(--cc-color-2)" },
      "&:is(a) :is((h1,h2,h3,h4,h5,h6)):hover": { color: "var(--cc-color-2)" },
      color: "var(--cc-color-1)",
    });
  });

  test("text-white: a 14-member list, tag-qualified member, base color from the bare member", () => {
    expect(styleOf(index, "text-white")).toEqual({
      "& p": { color: "var(--cc-color-background)" },
      "& a": { color: "var(--cc-color-background)" },
      "& h1": { color: "var(--cc-color-background)" },
      "& h2": { color: "var(--cc-color-background)" },
      "& h3": { color: "var(--cc-color-background)" },
      "& h4": { color: "var(--cc-color-background)" },
      "&:is(a) p": { color: "var(--cc-color-background)" },
      color: "var(--cc-color-background)",
    });
  });

  test("icon-white: a base rule and a list rule for the same path merge into one key", () => {
    expect(styleOf(index, "icon-white")).toEqual({
      "& path": { fill: "white", color: "var(--cc-color-5)" },
      color: "var(--cc-color-5)",
    });
  });

  test("filter-default: attribute-free child and pseudo-class descendants", () => {
    expect(styleOf(index, "filter-default")).toEqual({
      "& > select": {
        fontSize: "1rem",
        borderColor: "var(--cc-color-4)",
        borderRadius: ".5rem",
        borderWidth: "1px",
        borderStyle: "solid",
        padding: ".5rem",
      },
      "& option": { color: "var(--cc-color-1)", fontStyle: "italic" },
      "& option:first-child": { fontWeight: "700" },
    });
  });

  test("`:where(.a .b)` is not rooted at a class: it goes to `other` under its selector", () => {
    expect([...index.other.keys()]).toEqual([":where(.unknown-class .cc-nav-toggle)"]);
    expect(index.other.get(":where(.unknown-class .cc-nav-toggle)")).toEqual({ display: "none" });
  });

  test("link-white: a bare rule and a list rule both land on the class, the descendant on `& a`", () => {
    expect(styleOf(index, "link-white")).toEqual({
      justifyContent: "center",
      display: "flex",
      flexDirection: "column",
      color: "var(--cc-color-6)",
      "& a": { color: "var(--cc-color-6)" },
    });
  });
});

describe("ap/cc-global-classes.css", () => {
  const index = parse(readFixtureCss("ap", "cc-global-classes.css"));

  test("a plain declaration after an !important one does not displace it (button-light)", () => {
    // .button-light{color:var(--cc-color-2) !important} … .button-light.ff-btn,.button-light{background-color:…;color:var(--cc-color-2)}
    expect(styleOf(index, "button-light")?.["color"]).toBe("var(--cc-color-2) !important");
    // `border-radius:9999px !important` is later followed by nothing plain, and stays important too.
    expect(styleOf(index, "button-light")).toMatchObject({
      borderRadius: "9999px !important",
      borderWidth: "2px !important",
    });
    // The `.ff-btn` compound has no !important rule of its own, so the later plain `color` is simply its color.
    expect(index.other.get(".button-light.ff-btn")).toEqual({
      borderColor: "var(--cc-color-2)",
      borderRadius: "99999px",
      borderWidth: "3px",
      borderStyle: "solid",
      backgroundColor: "var(--cc-color-5)",
      color: "var(--cc-color-2)",
    });
  });

  test("a later plain declaration of a breakpoint stays in that breakpoint (searchform-filter min-width 20rem / md 15rem / sm 60vw)", () => {
    expect(styleOf(index, "searchform-filter")).toMatchObject({
      minWidth: "20rem",
      "@--md": { minWidth: "15rem" },
      "@--sm": { minWidth: "60vw" },
    });
  });

  test("searchform keeps what is real next to the dropped !var= rule", () => {
    expect(styleOf(index, "searchform")).toEqual({
      "& .cc-icn": {
        backgroundColor: "var(--cc-color-5)",
        borderRadius: "100%",
        position: "absolute",
        top: "0.3rem",
        right: "0.3rem",
        zIndex: "3",
        padding: "0.4rem",
      },
      "& .cc-icn svg": { color: "var(--cc-color-1)", height: "1.1rem", width: "1.1rem" },
      position: "relative",
      minWidth: "20rem",
    });
  });

  test("a value that is itself invalid CSS (`0px!important 2px !important`) is reported and dropped, not carried", () => {
    // A browser throws the declaration away, so the rule has no padding of its own; carrying the text
    // would put an invalid declaration in the index, where it could replace a valid one.
    expect(styleOf(index, "wp-block-search")?.["& .wp-block-search__button"]).not.toHaveProperty(
      "padding",
    );
    expect(
      index.artifacts.filter((artifact) => artifact.code === CSS_ARTIFACT.invalidValue),
    ).toEqual([
      {
        code: "css.invalid-value",
        selector: ".wp-block-search .wp-block-search__button",
        detail:
          'padding: invalid value "0px!important 2px" (`!important` in the middle of the value)',
      },
      {
        code: "css.invalid-value",
        selector: ".card input",
        detail:
          'padding: invalid value "0.15rem!important 0.1rem" (`!important` in the middle of the value)',
      },
    ]);
  });

  test("a rule that is a bare `body` selector is kept under `other`", () => {
    const globals = parse(readFixtureCss("ap", "cc-global-stylesheets.css"));
    expect(globals.other.get("body")).toEqual({
      maxWidth: "100vw",
      overflowX: "clip",
      overflowY: "scroll",
    });
    expect(globals.other.get("fieldset#give_cc_fields")).toEqual({
      columnGap: "1rem",
      display: "flex",
      flexWrap: "wrap",
      rowGap: "1rem",
    });
  });
});

describe("compiled-CSS options", () => {
  const index = parse(fixtureOptionCss("fineline", "cwicly_global_css")!);

  test("native nesting is flattened per member of the parent's list", () => {
    // `:root, .light { --cc-color-background:#ffffff; … .has-cc-xew-3-h-color{color:#d5312d} … }`
    expect(index.other.get(":root")?.["--cc-color-background"]).toBe("#ffffff");
    expect(styleOf(index, "light")?.["--cc-color-background"]).toBe("#ffffff");
    expect(index.other.get(":root .has-cc-xew-3-h-color")).toEqual({ color: "#d5312d" });
    expect(styleOf(index, "light")?.["& .has-cc-xew-3-h-color"]).toEqual({ color: "#d5312d" });
    expect(index.other.get(":root .has-cc-xew-3-h-background-color")).toEqual({
      backgroundColor: "#d5312d",
    });
  });

  test("custom properties keep their case and are never camelCased", () => {
    const names = Object.keys(index.other.get(":root")!).filter((key) => key.startsWith("--"));
    expect(names).toContain("--cc-color-1-hsl");
    expect(names).toContain("--color-kbvn1");
  });

  test("@supports nests inside @--md, and attribute selectors stay on their class", () => {
    const nav = styleOf(index, "cc-nav")!;
    expect(nav['&[breakpoint="lg"] .cc-nav-toggle']).toEqual({ display: "block" });
    expect((nav["@--md"] as JxStyle)["@supports (height: 100dvh)"]).toEqual({
      '&[breakpoint="md"] .cc-nav-wrapper': { minHeight: "100dvh", maxHeight: "100dvh" },
    });
  });

  test("tag rules go to `other`, breakpoints nested", () => {
    // h1{color:var(--cc-color-1);font-family:"Source Sans Pro";font-weight:700;font-size:3.2em;line-height:1.2;text-align:center}
    // @media 992 {h1{font-size:2.8em;line-height:1.1}}  @media 576 {h1{font-size:2em;line-height:1.2}}
    expect(index.other.get("h1")).toEqual({
      color: "var(--cc-color-1)",
      fontFamily: '"Source Sans Pro"',
      fontWeight: "700",
      fontSize: "3.2em",
      lineHeight: "1.2",
      textAlign: "center",
      "@--md": { fontSize: "2.8em", lineHeight: "1.1" },
      "@--sm": { fontSize: "2em", lineHeight: "1.2" },
    });
    expect(index.other.get("p")).toEqual({ marginTop: "1rem", marginBottom: "1rem" });
    expect(index.other.get("a")).toEqual({ color: "var(--cc-color-2)" });
  });

  test("a later rule replaces the generator's system font stack in place", () => {
    // body{font-family: -apple-system, …}  body{background-color:…}  body{color:#2c324d;font-family:"Source Sans Pro";…}
    const body = index.other.get("body")!;
    expect(body).toEqual({
      fontFamily: '"Source Sans Pro"',
      backgroundColor: "var(--cc-color-background)",
      color: "#2c324d",
      fontWeight: "normal",
      fontSize: "20px",
      lineHeight: "1.5",
      textAlign: "left",
    });
    expect(Object.keys(body)[0]).toBe("fontFamily");
  });

  test("a later rule for the same class replaces a declaration in place (columns-c3975bf display flex → grid)", () => {
    // .columns-c3975bf{position:relative;display:flex;width:100%}
    // .columns-c3975bf{display: grid;grid-template-columns: 1fr 1fr;grid-auto-rows: minmax(100px, auto);row-gap: 10px;-moz-column-gap: 10px;column-gap: 10px}
    const page = parse(readFixtureCss("fineline", "cc-post-5278.css"));
    const style = styleOf(page, "columns-c3975bf")!;
    expect(Object.keys(style).slice(0, 7)).toEqual([
      "position",
      "display",
      "width",
      "gridTemplateColumns",
      "gridAutoRows",
      "rowGap",
      "columnGap",
    ]);
    expect(style["display"]).toBe("grid");
    expect(style["gridTemplateColumns"]).toBe("1fr 1fr");
    expect(style["@--sm"]).toMatchObject({ display: "grid", gridTemplateColumns: "1fr" });
  });
});

describe("a page's stylesheets, in the order the rendered page loads them", () => {
  const PAGES = FIXTURE_SITES.flatMap((site) =>
    readdirSync(join(fixtureDir(site), "html"))
      .filter((file) => file.endsWith(".html"))
      .sort()
      .map((file) => ({ site, file, html: readFixtureText(site, `html/${file}`) })),
  );

  /** The Cwicly stylesheets a rendered page links, in document order. */
  const linked = (html: string): string[] =>
    [
      ...html.matchAll(/<link[^>]+href=['"][^'"]*\/uploads\/cwicly\/(?:css\/)?(cc-[^?'"]+)[?'"]/g),
    ].map((match) => match[1]!);

  test("there are 12 rendered pages to check against", () => {
    expect(PAGES).toHaveLength(12);
  });

  for (const { site, file, html } of PAGES) {
    describe(`${site}/${file}`, () => {
      const names = linked(html);

      test("every stylesheet the page links is in the fixture", async () => {
        expect(names.length).toBeGreaterThanOrEqual(5);
        const index = await loadCssIndex(fixtureCssSource(site), names, BPS);
        expect(codesOf(index)).not.toContain(CSS_ARTIFACT.missingFile);
      });

      test("the merged index equals the CSS cascade of those files concatenated", async () => {
        const index = await loadCssIndex(fixtureCssSource(site), names, BPS);
        const cascade = names.map((name) => readFixtureCss(site, name)).join("\n");
        const original = canonicalCss(cascade, BPS);
        const rendered = canonicalCss(renderCssIndex(index, BPS));
        expect(canonicalDiff(original, rendered)).toEqual([]);
        expect(rendered.rules).toEqual(original.rules);
        // Identical @import lines from two files are one @import in the merged index.
        const unique = new Set<string>();
        const atRules = original.atRules.filter((rule) => {
          const fingerprint = JSON.stringify(rule);
          if (unique.has(fingerprint)) return false;
          unique.add(fingerprint);
          return true;
        });
        expect(rendered.atRules).toEqual(atRules);
        expect(countBy(index)).toEqual(original.artifacts);
      });

      test("every classID the page uses, and the stylesheets mention, has a style in the index", async () => {
        const index = await loadCssIndex(fixtureCssSource(site), names, BPS);
        const stylesheetText = names.map((name) => readFixtureCss(site, name)).join("\n");
        const tokens = new Set<string>();
        for (const match of html.matchAll(/\sclass=["']([^"']*)["']/g)) {
          for (const token of match[1]!.split(/\s+/))
            if (/^[a-z][a-z-]*-c[0-9a-f]{6,7}$/.test(token)) tokens.add(token);
        }
        expect(tokens.size).toBeGreaterThan(20);
        let checked = 0;
        for (const token of tokens) {
          if (!new RegExp(String.raw`\.${token}(?![\w-])`).test(stylesheetText)) continue;
          checked += 1;
          const known =
            index.classes.has(token) ||
            [...index.other.keys()].some((selector) => selector.includes(`.${token}`));
          expect({ token, known }).toEqual({ token, known: true });
        }
        expect(checked).toBeGreaterThan(20);
      });
    });
  }
});

// ── Synthetic CSS: the shapes the fixtures lack ──────────────────────────────────────────────────

describe("classifySelector", () => {
  const cases: [string, ReturnType<typeof classifySelector>][] = [
    // (a) exactly one class, optionally with pseudo-classes / pseudo-elements
    [".a", { kind: "class", name: "a", key: "" }],
    [".a:hover", { kind: "class", name: "a", key: ":hover" }],
    [".a:before", { kind: "class", name: "a", key: "::before" }],
    [".a:after", { kind: "class", name: "a", key: "::after" }],
    [".a:first-line", { kind: "class", name: "a", key: "::first-line" }],
    [".a:first-letter", { kind: "class", name: "a", key: "::first-letter" }],
    [".a:BEFORE", { kind: "class", name: "a", key: "::before" }],
    [".a::before", { kind: "class", name: "a", key: "::before" }],
    [".a:hover::before", { kind: "class", name: "a", key: ":hover::before" }],
    [".a:hover:before", { kind: "class", name: "a", key: ":hover::before" }],
    [".a[disabled]", { kind: "class", name: "a", key: "[disabled]" }],
    [".a:not(.b)", { kind: "class", name: "a", key: ":not(.b)" }],
    [".a:nth-child(2n + 1)", { kind: "class", name: "a", key: ":nth-child(2n + 1)" }],
    [":hover.a", { kind: "class", name: "a", key: ":hover" }],
    // (b) the first compound is the class and the selector goes on
    [".a svg", { kind: "class", name: "a", key: "& svg" }],
    [".a   svg", { kind: "class", name: "a", key: "& svg" }],
    [".a\n\tsvg", { kind: "class", name: "a", key: "& svg" }],
    [".a > div:nth-of-type(1)", { kind: "class", name: "a", key: "& > div:nth-of-type(1)" }],
    [".a>div:nth-of-type(1)", { kind: "class", name: "a", key: "& > div:nth-of-type(1)" }],
    [".a:hover svg", { kind: "class", name: "a", key: "&:hover svg" }],
    [".a:hover .b:before", { kind: "class", name: "a", key: "&:hover .b::before" }],
    [".a + .b", { kind: "class", name: "a", key: "& + .b" }],
    [".a~.b", { kind: "class", name: "a", key: "& ~ .b" }],
    [".a .b .c", { kind: "class", name: "a", key: "& .b .c" }],
    [".a ul>li", { kind: "class", name: "a", key: "& ul > li" }],
    [".a[is-modal=true] .b", { kind: "class", name: "a", key: "&[is-modal=true] .b" }],
    [".a .b:is(h1, h2)", { kind: "class", name: "a", key: "& .b:is(h1, h2)" }],
    [".a *", { kind: "class", name: "a", key: "& *" }],
    [".a > *", { kind: "class", name: "a", key: "& > *" }],
    [".a #x", { kind: "class", name: "a", key: "& #x" }],
    // (c) tag-qualified compound on the class itself
    ["a.b", { kind: "class", name: "b", key: "&:is(a)" }],
    ["a.b:hover", { kind: "class", name: "b", key: "&:is(a):hover" }],
    ["a.b::before", { kind: "class", name: "b", key: "&:is(a)::before" }],
    ["a.b svg", { kind: "class", name: "b", key: "&:is(a) svg" }],
    ["a.b:hover svg", { kind: "class", name: "b", key: "&:is(a):hover svg" }],
    ["a.b>div", { kind: "class", name: "b", key: "&:is(a) > div" }],
    ["input.give-gateway", { kind: "class", name: "give-gateway", key: "&:is(input)" }],
    // names are unescaped
    [".md\\:flex .x", { kind: "class", name: "md:flex", key: "& .x" }],
    // (d) anything else: keyed by the selector itself
    [".a.b", { kind: "other", selector: ".a.b" }],
    [".a.b:hover", { kind: "other", selector: ".a.b:hover" }],
    [".a.b .c", { kind: "other", selector: ".a.b .c" }],
    [".a.b>.c", { kind: "other", selector: ".a.b > .c" }],
    ["body", { kind: "other", selector: "body" }],
    ["h1", { kind: "other", selector: "h1" }],
    ["*", { kind: "other", selector: "*" }],
    [":root", { kind: "other", selector: ":root" }],
    ["#id", { kind: "other", selector: "#id" }],
    ["#id .a", { kind: "other", selector: "#id .a" }],
    ["fieldset#x legend", { kind: "other", selector: "fieldset#x legend" }],
    ["a .b", { kind: "other", selector: "a .b" }],
    ["body  >  .b:before", { kind: "other", selector: "body > .b::before" }],
    [":where(.a .b)", { kind: "other", selector: ":where(.a .b)" }],
    [":is(.a, .b)", { kind: "other", selector: ":is(.a, .b)" }],
    ["svg|a.cls", { kind: "other", selector: "svg|a.cls" }],
    ["*.cls", { kind: "other", selector: "*.cls" }],
    // not a selector at all
    ["", null],
    [".a >", null],
    ["> .a", null],
  ];
  for (const [selector, expected] of cases) {
    test(JSON.stringify(selector), () => {
      expect(classifySelector(selector)).toEqual(expected);
    });
  }
});

describe("jxStyleKey", () => {
  const cases: [string, string | null][] = [
    ["margin-top", "marginTop"],
    ["color", "color"],
    ["float", "float"],
    ["-webkit-line-clamp", "WebkitLineClamp"],
    ["-moz-column-break-inside", "MozColumnBreakInside"],
    ["-ms-flex-pack", "MsFlexPack"],
    ["-o-object-fit", "OObjectFit"],
    ["--cc-ha_ll", "--cc-ha_ll"],
    ["--Mixed-Case", "--Mixed-Case"],
    ["COLOR", "color"],
    ["Margin-Top", "marginTop"],
    ["*zoom", null],
    ["_height", null],
    ["--", null],
    ["", null],
    ["a--b", null],
    ["a-1", null],
  ];
  for (const [property, key] of cases) {
    test(JSON.stringify(property), () => {
      expect(jxStyleKey(property)).toBe(key);
    });
  }

  test("every key written survives the real camelToKebab", () => {
    for (const property of [
      "-webkit-line-clamp",
      "-ms-flex-pack",
      "-o-object-fit",
      "-moz-appearance",
      "grid-template-columns",
      "z-index",
    ]) {
      expect(camelToKebab(jxStyleKey(property)!)).toBe(property);
    }
  });
});

describe("declarations", () => {
  test("autoprefixer's prefixed values collapse into the standard one", () => {
    const index = parse(
      ".a{display:-webkit-box;display:-ms-flexbox;display:flex}.b{width:-webkit-fit-content;width:-moz-fit-content;width:fit-content}",
    );
    expect(styleOf(index, "a")).toEqual({ display: "flex" });
    expect(styleOf(index, "b")).toEqual({ width: "fit-content" });
  });

  test("a prefixed value with no standard one after it is kept (it is the only declaration that works)", () => {
    const index = parse(
      ".a{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}",
    );
    expect(styleOf(index, "a")).toEqual({
      display: "-webkit-box",
      WebkitLineClamp: "3",
      WebkitBoxOrient: "vertical",
      overflow: "hidden",
    });
  });

  test("a prefixed property whose twin is in the same rule is dropped; prefixed-only properties stay", () => {
    const index = parse(
      ".a{-webkit-line-clamp:2;-moz-column-gap:1rem;column-gap:1rem;-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);-o-object-fit:cover;-ms-flex-pack:center}",
    );
    expect(styleOf(index, "a")).toEqual({
      WebkitLineClamp: "2",
      columnGap: "1rem",
      backdropFilter: "blur(4px)",
      OObjectFit: "cover",
      MsFlexPack: "center",
    });
    for (const key of Object.keys(styleOf(index, "a")!))
      expect(camelToKebab(key)).toBe(cssPropertyName(key));
  });

  test("the twin has to be in the SAME rule: a prefixed property in another rule is not a duplicate", () => {
    const index = parse(".a{-webkit-clip-path:circle(5px)}.a{clip-path:circle(5px)}");
    expect(styleOf(index, "a")).toEqual({ WebkitClipPath: "circle(5px)", clipPath: "circle(5px)" });
  });

  test("a prefixed value AFTER the standard one is a deliberate override and survives", () => {
    expect(styleOf(parse(".a{display:flex;display:-webkit-box}"), "a")).toEqual({
      display: "-webkit-box",
    });
  });

  test("custom properties are untouched and case-sensitive; other names are lower-cased", () => {
    const index = parse(".a{--fooBar:1;--foo-bar:2;--cc-ha_ll:3;COLOR:Red;Margin-Top:1px}");
    expect(styleOf(index, "a")).toEqual({
      "--fooBar": "1",
      "--foo-bar": "2",
      "--cc-ha_ll": "3",
      color: "Red",
      marginTop: "1px",
    });
  });

  test("values are trimmed, comments removed, everything else verbatim", () => {
    const index = parse(
      '.a{ color :  red  ;margin: 0   auto /* c */;filter:contrast(99%)hue-rotate(10deg);background:url(data:image/svg+xml;base64,AAA=) no-repeat;content:"a;b"}',
    );
    expect(styleOf(index, "a")).toEqual({
      color: "red",
      margin: "0   auto",
      filter: "contrast(99%)hue-rotate(10deg)",
      background: "url(data:image/svg+xml;base64,AAA=) no-repeat",
      content: '"a;b"',
    });
  });

  test("!important is kept, normalised to ` !important`", () => {
    const index = parse(".a{color:red!important;margin:0 ! important;padding:1px !IMPORTANT}");
    expect(styleOf(index, "a")).toEqual({
      color: "red !important",
      margin: "0 !important",
      padding: "1px !important",
    });
  });

  test("repeated declarations: later wins in place, key order is that of first appearance", () => {
    const index = parse(".a{color:red;margin:0;padding:1px}.a{color:blue}.a{margin:2px;border:0}");
    const style = styleOf(index, "a")!;
    expect(style).toEqual({ color: "blue", margin: "2px", padding: "1px", border: "0" });
    expect(Object.keys(style)).toEqual(["color", "margin", "padding", "border"]);
  });

  test("a plain declaration never displaces an !important one; a later !important does", () => {
    expect(styleOf(parse(".a{color:red!important}.a{color:blue}"), "a")).toEqual({
      color: "red !important",
    });
    expect(styleOf(parse(".a{color:red}.a{color:blue!important}"), "a")).toEqual({
      color: "blue !important",
    });
    expect(styleOf(parse(".a{color:red!important}.a{color:blue!important}"), "a")).toEqual({
      color: "blue !important",
    });
    expect(styleOf(parse(".a{color:red!important;color:blue}"), "a")).toEqual({
      color: "red !important",
    });
  });

  test(".a:before and .a::before are one key", () => {
    const index = parse('.a:before{content:"x"}.a::before{color:red}');
    expect(styleOf(index, "a")).toEqual({ "::before": { content: '"x"', color: "red" } });
  });

  test("rules with no declarations leave nothing behind", () => {
    const index = parse(".a{}.b{ }.c:hover{}@media screen and (max-width:992px){.d{}}");
    expect(index.classes.size).toBe(0);
    expect(index.other.size).toBe(0);
    expect(index.artifacts).toEqual([]);
  });

  test("a selector list with an empty-body rule and a real one", () => {
    const index = parse(".a,.b{color:red}");
    expect(styleOf(index, "a")).toEqual({ color: "red" });
    expect(styleOf(index, "b")).toEqual({ color: "red" });
    expect(styleOf(index, "a")).not.toBe(styleOf(index, "b"));
  });
});

describe("media queries", () => {
  const withMin: Breakpoint[] = [
    { key: "xl", width: 1920, isMain: false, direction: "min" },
    ...BPS,
  ];

  test("main-breakpoint rules are unwrapped, max-width queries become @--<key> with or without `screen and` and spaces", () => {
    const index = parse(
      ".a{color:red}@media screen and (max-width: 992px){.a{color:green}}@media (max-width:576px){.a{color:blue}}@media   SCREEN  AND (max-width:992px){.a{margin:0}}",
    );
    expect(styleOf(index, "a")).toEqual({
      color: "red",
      "@--md": { color: "green", margin: "0" },
      "@--sm": { color: "blue" },
    });
    expect(index.artifacts).toEqual([]);
  });

  test("the main breakpoint is never a media query, even for a query with its width", () => {
    const mislabelled: Breakpoint[] = [
      { key: "lg", width: 1366, isMain: true, direction: "max" },
      ...BPS.slice(1),
    ];
    const index = parse("@media screen and (max-width: 1366px){.a{color:red}}", mislabelled);
    expect(styleOf(index, "a")).toEqual({ "@(max-width: 1366px)": { color: "red" } });
    expect(codesOf(index)).toEqual([CSS_ARTIFACT.mediaUnmapped]);
  });

  test("a min-width breakpoint maps likewise", () => {
    const index = parse("@media screen and (min-width: 1920px){.a{color:red}}", withMin);
    expect(styleOf(index, "a")).toEqual({ "@--xl": { color: "red" } });
    expect(index.artifacts).toEqual([]);
  });

  test("direction matters: a min-width query on a max breakpoint's width is not that breakpoint", () => {
    const index = parse("@media screen and (min-width: 992px){.a{color:red}}");
    expect(styleOf(index, "a")).toEqual({ "@(min-width: 992px)": { color: "red" } });
    expect(codesOf(index)).toEqual([CSS_ARTIFACT.mediaUnmapped]);
  });

  test("an unmapped query is kept as a literal @(…) key and reported", () => {
    const index = parse(
      "@media screen and (max-width: 700px){.a{color:red}}@media (min-width: 40rem) and (max-width: 60rem){.a{margin:0}}",
    );
    expect(styleOf(index, "a")).toEqual({
      "@(max-width: 700px)": { color: "red" },
      "@(min-width: 40rem) and (max-width: 60rem)": { margin: "0" },
    });
    expect(index.artifacts).toEqual([
      {
        code: "css.media-unmapped",
        selector: "@media screen and (max-width: 700px)",
        detail: 'media query "screen and (max-width: 700px)" names no breakpoint',
      },
      {
        code: "css.media-unmapped",
        selector: "@media (min-width: 40rem) and (max-width: 60rem)",
        detail: 'media query "(min-width: 40rem) and (max-width: 60rem)" names no breakpoint',
      },
    ]);
  });

  test("media types and queries Jx's @(…) form cannot carry are kept as @media keys", () => {
    const index = parse(
      "@media print{.a{color:red}}@media only screen and (max-width: 600px){.a{margin:0}}",
    );
    expect(styleOf(index, "a")).toEqual({
      "@(print)": { color: "red" },
      "@media only screen and (max-width: 600px)": { margin: "0" },
    });
    expect(codesOf(index)).toEqual([CSS_ARTIFACT.mediaUnmapped, CSS_ARTIFACT.mediaUnmapped]);
  });

  test("a colour-scheme query is a literal key too, which is what Jx reads as a scheme query", () => {
    const index = parse(
      "@media (prefers-color-scheme: dark){:root{--cc-color-1:#fff}.a{color:#fff}}",
    );
    expect(index.other.get(":root")).toEqual({
      "@(prefers-color-scheme: dark)": { "--cc-color-1": "#fff" },
    });
    expect(styleOf(index, "a")).toEqual({ "@(prefers-color-scheme: dark)": { color: "#fff" } });
    expect(codesOf(index)).toEqual([CSS_ARTIFACT.mediaUnmapped]);
  });

  test("pseudo-classes and descendants nest INSIDE the breakpoint key", () => {
    const index = parse(
      '@media screen and (max-width: 992px){.a:hover{color:red}.a svg{fill:blue}.a::before{content:""}}',
    );
    expect(styleOf(index, "a")).toEqual({
      "@--md": {
        ":hover": { color: "red" },
        "& svg": { fill: "blue" },
        "::before": { content: '""' },
      },
    });
  });

  test("`other` selectors nest breakpoints too", () => {
    const index = parse("body{color:red}@media screen and (max-width: 992px){body{color:blue}}");
    expect(index.other.get("body")).toEqual({ color: "red", "@--md": { color: "blue" } });
  });

  test("@supports (and friends) nest like @media, in either order", () => {
    const index = parse(
      "@supports (display: grid){.a{display:grid}}@media screen and (max-width: 992px){@supports (height: 100dvh){.a{height:100dvh}}}@layer base{.b{color:red}}",
    );
    expect(styleOf(index, "a")).toEqual({
      "@supports (display: grid)": { display: "grid" },
      "@--md": { "@supports (height: 100dvh)": { height: "100dvh" } },
    });
    expect(styleOf(index, "b")).toEqual({ "@layer base": { color: "red" } });
    expect(index.artifacts).toEqual([]);
  });

  test("the keys Jx will see resolve to the media queries they were read from", () => {
    const css =
      ".a{color:red}@media screen and (max-width: 992px){.a{color:green}.a:hover{color:blue}}@media screen and (max-width: 576px){.a{color:black}}";
    const rendered = canonicalCss(renderCssIndex(parse(css), BPS));
    expect(rendered.rules).toEqual(canonicalCss(css).rules);
    expect(rendered.rules[".a"]).toEqual({
      "": { color: "red" },
      "@media (max-width: 992px)": { color: "green" },
      "@media (max-width: 576px)": { color: "black" },
    });
  });
});

describe("selectors that become keys", () => {
  test("tag-qualified, hover, descendants and children all live under the class", () => {
    const index = parse(
      "a.c{color:red}a.c:hover{color:blue}a.c svg{fill:red}.c a{color:green}.c>div{margin:0}.c:hover svg{fill:blue}",
    );
    expect(styleOf(index, "c")).toEqual({
      "&:is(a)": { color: "red" },
      "&:is(a):hover": { color: "blue" },
      "&:is(a) svg": { fill: "red" },
      "& a": { color: "green" },
      "& > div": { margin: "0" },
      "&:hover svg": { fill: "blue" },
    });
  });

  test("spellings of one selector merge: `.a>.b`, `.a > .b`, `.a   >\\n.b`", () => {
    const index = parse(".a>.b{color:red}.a > .b{margin:0}.a   >\n.b{padding:0}");
    expect(styleOf(index, "a")).toEqual({ "& > .b": { color: "red", margin: "0", padding: "0" } });
  });

  test("class names with escapes are unescaped as keys", () => {
    const index = parse(".md\\:flex{display:flex}.\\31 23{color:red}");
    expect([...index.classes.keys()]).toEqual(["md:flex", "123"]);
  });

  test("a selector list is split on top-level commas only", () => {
    const index = parse(".a:is(.b, .c) .d, .e{color:red}");
    expect(styleOf(index, "a")).toEqual({ "&:is(.b, .c) .d": { color: "red" } });
    expect(styleOf(index, "e")).toEqual({ color: "red" });
  });

  test("a selector no parser can read is reported and costs only itself", () => {
    const index = parse(".a >{color:red}.b{color:blue}");
    expect(codesOf(index)).toEqual([CSS_ARTIFACT.unclassified]);
    expect(index.artifacts[0]!.selector).toBe(".a >");
    expect(styleOf(index, "b")).toEqual({ color: "blue" });
  });
});

describe("nested rules (CSS Nesting)", () => {
  test("a nested rule is a descendant of every member of its parent's list", () => {
    const index = parse(".p, .q .r { color: red; .x { color: blue } }");
    expect(styleOf(index, "p")).toEqual({ color: "red", "& .x": { color: "blue" } });
    expect(styleOf(index, "q")).toEqual({ "& .r": { color: "red" }, "& .r .x": { color: "blue" } });
  });

  test("&-forms: leading & is the parent, > starts a relative selector, other & uses :is()", () => {
    const index = parse(
      ".p { &:hover{color:green} & > .y{color:pink} > .z{color:gray} .w &{color:olive} & + &{color:navy} }",
    );
    expect(styleOf(index, "p")).toEqual({
      ":hover": { color: "green" },
      "& > .y": { color: "pink" },
      "& > .z": { color: "gray" },
    });
    expect(styleOf(index, "w")).toEqual({ "& :is(.p)": { color: "olive" } });
    expect(index.other.get(":is(.p) + :is(.p)")).toEqual({ color: "navy" });
  });

  test("an & inside an attribute value is not a nesting selector", () => {
    const index = parse('.p { [data-x="a&b"] { color: black } }');
    expect(styleOf(index, "p")).toEqual({ '& [data-x="a&b"]': { color: "black" } });
  });

  test("a conditional at-rule inside a rule applies to the rule's own selector", () => {
    const index = parse(
      ".p { color: red; @media screen and (max-width: 992px) { color: orange; .m { color: white } } }",
    );
    expect(styleOf(index, "p")).toEqual({
      color: "red",
      "@--md": { color: "orange", "& .m": { color: "white" } },
    });
  });

  test("any other at-rule inside a rule is reported", () => {
    const index = parse(".p { @page { margin: 0 } color: red }");
    expect(codesOf(index)).toEqual([CSS_ARTIFACT.unclassified]);
    expect(styleOf(index, "p")).toEqual({ color: "red" });
  });
});

describe("at-rules", () => {
  test("@font-face: one entry per face, in source order, properties camelCased", () => {
    const index = parse(
      '@font-face{font-family:"A";src:url(a.woff2) format("woff2"),url(a.woff) format("woff");font-weight:400;font-display:swap}@font-face{font-family:"A";src:url(b.woff2) format("woff2");font-weight:700}',
    );
    expect(index.atRules).toEqual([
      {
        key: "@font-face",
        style: {
          fontFamily: '"A"',
          src: 'url(a.woff2) format("woff2"),url(a.woff) format("woff")',
          fontWeight: "400",
          fontDisplay: "swap",
        },
      },
      {
        key: "@font-face",
        style: { fontFamily: '"A"', src: 'url(b.woff2) format("woff2")', fontWeight: "700" },
      },
    ]);
    expect(index.classes.size).toBe(0);
  });

  test("@keyframes: stops keyed by their selector, in the shape Jx's rule builder reads", () => {
    const index = parse(
      "@keyframes spin{from{transform:rotate(0deg)}50%{opacity:.5}to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}}",
    );
    expect(index.atRules).toEqual([
      {
        key: "@keyframes spin",
        style: {
          from: { transform: "rotate(0deg)" },
          "50%": { opacity: ".5" },
          to: { transform: "rotate(360deg)" },
        },
      },
      { key: "@keyframes pulse", style: { "0%, 100%": { opacity: "1" } } },
    ]);
    // The real Jx builder turns them back into one @keyframes block each.
    const text = renderCssIndex(index, BPS);
    expect(canonicalCss(text).atRules).toEqual(
      canonicalCss(
        "@keyframes spin{from{transform:rotate(0deg)}50%{opacity:.5}to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}}",
      ).atRules,
    );
  });

  test("at-rules with nothing in them are not recorded", () => {
    const index = parse(
      "@font-face{}@font-face{font-family:x;src:url({imagesrc=1})}@keyframes a{}@keyframes b{from{}to{width:[object Object]px}}.a{color:red}",
    );
    // The two @font-face blocks and the second keyframes lose every declaration (artifacts or none at all).
    expect(index.atRules).toEqual([{ key: "@font-face", style: { fontFamily: "x" } }]);
    expect(styleOf(index, "a")).toEqual({ color: "red" });
  });

  test("@-webkit-keyframes is dropped when the unprefixed one is there, renamed when it is alone", () => {
    const both = parse(
      "@-webkit-keyframes x{from{opacity:0}to{opacity:1}}@keyframes x{from{opacity:0}to{opacity:1}}",
    );
    expect(both.atRules).toEqual([
      { key: "@keyframes x", style: { from: { opacity: "0" }, to: { opacity: "1" } } },
    ]);
    const alone = parse("@-webkit-keyframes y{from{opacity:0}}");
    expect(alone.atRules).toEqual([{ key: "@keyframes y", style: { from: { opacity: "0" } } }]);
    expect(alone.artifacts).toEqual([]);
  });

  test("@import is a statement entry: its head is the key, its style is empty", () => {
    const index = parse(
      '@import url("https://fonts.googleapis.com/css?family=Reem Kufi:100,100italic&display=swap");.a{color:red}',
    );
    expect(index.atRules).toEqual([
      {
        key: '@import url("https://fonts.googleapis.com/css?family=Reem Kufi:100,100italic&display=swap")',
        style: {},
      },
    ]);
    expect(renderCssIndex(index, BPS)).toContain("@import url(");
  });

  test("whitespace in an at-rule's head is collapsed, except inside quoted strings", () => {
    const index = parse(
      '@import   url("https://x/y?family=A  B")   screen;@supports   (display:   grid)  {.a{display:grid}}',
    );
    expect(index.atRules.map((rule) => rule.key)).toEqual([
      '@import url("https://x/y?family=A  B") screen',
    ]);
    expect(Object.keys(styleOf(index, "a")!)).toEqual(["@supports (display: grid)"]);
  });

  test("the two Google Fonts imports in the real corpus", () => {
    const header = parse(readFixtureCss("fineline", "cc-tp-cwicly_header.css"));
    expect(header.atRules).toHaveLength(1);
    expect(header.atRules[0]!.key).toStartWith(
      '@import url("https://fonts.googleapis.com/css?family=Reem Kufi:100,100italic',
    );
    expect(header.atRules[0]!.style).toEqual({});
    const post = parse(readFixtureCss("fineline", "cc-post-1714.css"));
    expect(post.atRules[0]!.key).toContain("family=Inter:");
  });

  test("@charset says nothing Jx needs; every other at-rule is reported and dropped", () => {
    const index = parse(
      '@charset "UTF-8";@page{margin:1cm}@namespace svg url(http://www.w3.org/2000/svg);.a{color:red}',
    );
    expect(codesOf(index)).toEqual([CSS_ARTIFACT.unclassified, CSS_ARTIFACT.unclassified]);
    expect(index.artifacts.map((artifact) => artifact.selector)).toEqual([
      "@page",
      "@namespace svg url(http://www.w3.org/2000/svg)",
    ]);
    expect(styleOf(index, "a")).toEqual({ color: "red" });
  });

  test("a declaration at-rule inside a conditional one cannot be placed", () => {
    const index = parse("@media print{@font-face{font-family:x}}");
    expect(codesOf(index)).toEqual([CSS_ARTIFACT.mediaUnmapped, CSS_ARTIFACT.unclassified]);
    expect(index.atRules).toEqual([]);
  });
});

describe("artifacts", () => {
  test("every !var=<id>! is reported with its id and the declaration is dropped", () => {
    const index = parse(
      ".a{color:red;background:linear-gradient(!var=aa11!,!var=bb22!);fill:!var=cc33! !important}",
    );
    expect(styleOf(index, "a")).toEqual({ color: "red" });
    expect(index.artifacts.map((a) => a.code)).toEqual([
      CSS_ARTIFACT.unresolvedPaletteVar,
      CSS_ARTIFACT.unresolvedPaletteVar,
      CSS_ARTIFACT.unresolvedPaletteVar,
    ]);
    expect(index.artifacts.map((a) => a.detail)).toEqual([
      'background: the generator left the palette reference "aa11" unresolved',
      'background: the generator left the palette reference "bb22" unresolved',
      'fill: the generator left the palette reference "cc33" unresolved',
    ]);
    expect(new Set(index.artifacts.map((a) => a.selector))).toEqual(new Set([".a"]));
  });

  test("unresolved render-time tokens are reported, in values and in selectors", () => {
    const index = parse(
      '.a{background-image:url({imagesrc=12});content:"{title}";color:red;--x:<ccd>customfield=color</ccd>}.b{margin:0}',
    );
    expect(styleOf(index, "a")).toEqual({ color: "red" });
    expect(codesOf(index)).toEqual([CSS_ARTIFACT.token, CSS_ARTIFACT.token, CSS_ARTIFACT.token]);
    const inSelector = parse('.a[data-x="{postquery=1}"]{color:red}');
    expect(codesOf(inSelector)).toEqual([CSS_ARTIFACT.token]);
    expect(inSelector.classes.size).toBe(0);
  });

  test("a value that is a stringified JS value is reported once per declaration", () => {
    const index = parse(
      ".a{width:[object Object]px;clip-path:polygon(undefined% undefined%,50% 50%);height:undefinedpx;margin:1px}",
    );
    expect(styleOf(index, "a")).toEqual({ margin: "1px" });
    expect(codesOf(index)).toEqual([
      CSS_ARTIFACT.invalidValue,
      CSS_ARTIFACT.invalidValue,
      CSS_ARTIFACT.invalidValue,
    ]);
  });

  test("`undefined` selectors: only a name that STARTS with it is the generator's bug", () => {
    const index = parse(
      ".undefined{color:red}undefinedsection-c1 p{color:red}.ok,undefinedx{color:blue}.is-undefined-state{color:green}.has-undefined{color:green}",
    );
    expect(codesOf(index)).toEqual([
      CSS_ARTIFACT.undefinedSelector,
      CSS_ARTIFACT.undefinedSelector,
      CSS_ARTIFACT.undefinedSelector,
    ]);
    expect([...index.classes.keys()]).toEqual(["ok", "is-undefined-state", "has-undefined"]);
  });

  test("a stray `$scss-variable: x;` at the root is reported without a selector", () => {
    const index = parse("$accent: #4c9ffe;\n.a{color:red}");
    expect(index.artifacts).toEqual([
      { code: "css.unclassified", detail: 'property name "$accent" cannot be a Jx style key' },
    ]);
    expect(styleOf(index, "a")).toEqual({ color: "red" });
  });

  test("a property name no Jx key can spell is reported and its declaration dropped", () => {
    const index = parse(".a{$accent:red;color:red}");
    expect(styleOf(index, "a")).toEqual({ color: "red" });
    expect(index.artifacts).toEqual([
      {
        code: "css.unclassified",
        selector: ".a",
        detail: 'property name "$accent" cannot be a Jx style key',
      },
    ]);
  });

  test("IE property hacks (`*zoom`, `_height`) are invalid in every other browser, so they are reported and dropped", () => {
    const index = parse(".a{*zoom:1;_height:1px;color:red}");
    expect(styleOf(index, "a")).toEqual({ color: "red" });
    expect(index.artifacts.map((artifact) => artifact.detail)).toEqual([
      '"*zoom" is an IE property hack',
      '"_height" is an IE property hack',
    ]);
  });

  test("text that cannot be read at all is one artifact and an empty index, not an exception", () => {
    // A `}` with nothing open can only be the start of a rule that is invalid; so can a bare word.
    for (const css of ["}", "}.a{color:red}", "color red"]) {
      const index = parse(css);
      expect(codesOf(index)).toEqual([CSS_ARTIFACT.syntaxError]);
      expect(index.artifacts[0]!.detail).toContain("line 1");
      expect(index.classes.size + index.other.size + index.atRules.length).toBe(0);
    }
  });

  test("empty and whitespace-only input is an empty index with nothing to report", () => {
    for (const css of ["", "  \n\t "]) {
      const index = parse(css);
      expect(
        index.classes.size + index.other.size + index.atRules.length + index.artifacts.length,
      ).toBe(0);
    }
  });

  test("`file` is also a field of every artifact, and absent when no file was named", () => {
    const named = parseCwiclyCss(".undefined{}.a{width:[object Object]px}", BPS, {
      file: "cc-post-9.css",
    });
    expect(named.artifacts.map((artifact) => artifact.file)).toEqual([
      "cc-post-9.css",
      "cc-post-9.css",
    ]);
    const anonymous = parse(".undefined{}.a{width:[object Object]px}");
    for (const artifact of anonymous.artifacts) expect(artifact).not.toHaveProperty("file");
  });

  test("`file` is named in every artifact's detail when given", () => {
    const index = parseCwiclyCss(".undefined{}.a{width:[object Object]px}", BPS, {
      file: "cc-post-9.css",
    });
    expect(index.artifacts).toHaveLength(2);
    for (const artifact of index.artifacts) expect(artifact.detail).toEndWith("(in cc-post-9.css)");
  });
});

// ── mergeCssIndexes ──────────────────────────────────────────────────────────────────────────────

describe("emptyCssIndex", () => {
  test("is an index with nothing in it, and every call gives a fresh one", () => {
    const one = emptyCssIndex();
    expect(one.classes.size + one.other.size + one.atRules.length + one.artifacts.length).toBe(0);
    expect(emptyCssIndex().atRules).not.toBe(one.atRules);
    expect(emptyCssIndex().classes).not.toBe(one.classes);
  });
});

describe("mergeCssIndexes", () => {
  const deepFreeze = <T>(value: T): T => {
    if (value instanceof Map) {
      for (const [key, entry] of value) {
        deepFreeze(key);
        deepFreeze(entry);
      }
    } else if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) deepFreeze(entry);
    }
    return Object.freeze(value);
  };

  test("no arguments: an empty index", () => {
    const merged = mergeCssIndexes();
    expect(
      merged.classes.size + merged.other.size + merged.atRules.length + merged.artifacts.length,
    ).toBe(0);
  });

  test("later wins, nested blocks merge, keys keep the first file's order", () => {
    const merged = mergeCssIndexes(
      parse(
        ".a{color:red;margin:0}.a:hover{color:red}@media screen and (max-width: 992px){.a{color:red}}body{color:red}",
      ),
      parse(
        ".a{color:blue;padding:0}.a:hover{margin:0}@media screen and (max-width: 576px){.a{color:blue}}body{margin:0}.b{color:blue}",
      ),
    );
    expect(styleOf(merged, "a")).toEqual({
      color: "blue",
      margin: "0",
      ":hover": { color: "red", margin: "0" },
      "@--md": { color: "red" },
      padding: "0",
      "@--sm": { color: "blue" },
    });
    // The first file's keys keep their order; what the second file adds goes where Jx emits it
    // (own declarations, then nested selectors, then breakpoints), not after everything.
    expect(Object.keys(styleOf(merged, "a")!)).toEqual([
      "color",
      "margin",
      "padding",
      ":hover",
      "@--md",
      "@--sm",
    ]);
    expect(merged.other.get("body")).toEqual({ color: "red", margin: "0" });
    expect([...merged.classes.keys()]).toEqual(["a", "b"]);
  });

  test("an !important declaration survives a later plain one, and loses to a later !important", () => {
    const merged = mergeCssIndexes(parse(".a{color:red!important}"), parse(".a{color:blue}"));
    expect(styleOf(merged, "a")).toEqual({ color: "red !important" });
    expect(styleOf(mergeCssIndexes(merged, parse(".a{color:green!important}")), "a")).toEqual({
      color: "green !important",
    });
  });

  test("the result is the same as parsing the files concatenated, for everything the index can express", () => {
    const one =
      ".a{color:red;margin:0}.a:hover{color:red}.c svg{fill:red}@media screen and (max-width: 992px){.a{margin:1px}}";
    const two =
      ".a{color:blue}.a:hover{margin:0}.c svg{stroke:red}@media screen and (max-width: 992px){.a{padding:1px}}";
    const merged = mergeCssIndexes(parse(one), parse(two));
    const together = parse(`${one}${two}`);
    expect(Object.fromEntries(merged.classes)).toEqual(Object.fromEntries(together.classes));
  });

  test("artifacts concatenate in order; at-rules concatenate with exact duplicates dropped", () => {
    const first = parse('@import url("a.css");@font-face{font-family:x}.undefined{}');
    const second = parse(
      '@import url("a.css");@import url("b.css");@font-face{font-family:y}.q{width:[object Object]px}',
    );
    const merged = mergeCssIndexes(first, second);
    expect(merged.artifacts.map((a) => a.code)).toEqual([
      CSS_ARTIFACT.undefinedSelector,
      CSS_ARTIFACT.invalidValue,
    ]);
    expect(merged.atRules.map((rule) => [rule.key, rule.style])).toEqual([
      ['@import url("a.css")', {}],
      ["@font-face", { fontFamily: "x" }],
      ['@import url("b.css")', {}],
      ["@font-face", { fontFamily: "y" }],
    ]);
  });

  test("inputs are not modified and the result shares nothing with them", () => {
    const one = deepFreeze(
      parse(".a{color:red}.a:hover{color:red}body{color:red}@font-face{font-family:x}.undefined{}"),
    );
    const two = deepFreeze(parse(".a{color:blue}.a:hover{margin:0}body{margin:0}.b{color:blue}"));
    const merged = mergeCssIndexes(one, two);
    expect(styleOf(merged, "a")).toEqual({
      color: "blue",
      ":hover": { color: "red", margin: "0" },
    });
    expect(styleOf(one, "a")).toEqual({ color: "red", ":hover": { color: "red" } });
    // Mutating the result leaves the inputs alone (they are frozen: a write would throw, so it must be a copy).
    (styleOf(merged, "b") as JxStyle)["color"] = "changed";
    (merged.atRules[0]!.style as JxStyle)["fontFamily"] = "changed";
    expect(styleOf(two, "b")).toEqual({ color: "blue" });
    expect(one.atRules[0]!.style).toEqual({ fontFamily: "x" });
    expect(merged.artifacts[0]).not.toBe(one.artifacts[0]);
  });

  test("merging one index is a copy of it", () => {
    const index = parse(readFixtureCss("fineline", "cc-global-classes.css"));
    const merged = mergeCssIndexes(index);
    expect(Object.fromEntries(merged.classes)).toEqual(Object.fromEntries(index.classes));
    expect(merged.classes.get("card-default")).not.toBe(index.classes.get("card-default"));
    expect(merged.artifacts).toEqual(index.artifacts);
  });
});

// ── loadCssIndex ─────────────────────────────────────────────────────────────────────────────────

describe("loadCssIndex", () => {
  test("loads and merges in the order given (the cascade order), whichever file answers first", async () => {
    const source: CssSource = {
      async get(name) {
        // The first file is the slowest to arrive; the merge must still put it first.
        if (name === "one.css") await Bun.sleep(30);
        return { "one.css": ".a{color:red;margin:0}", "two.css": ".a{color:blue}" }[name] ?? null;
      },
    };
    const index = await loadCssIndex(source, ["one.css", "two.css"], BPS);
    expect(styleOf(index, "a")).toEqual({ color: "blue", margin: "0" });
    const reversed = await loadCssIndex(source, ["two.css", "one.css"], BPS);
    expect(styleOf(reversed, "a")).toEqual({ color: "red", margin: "0" });
  });

  test("a missing name is skipped and reported as css.missing-file, naming the file", async () => {
    const source = memorySource({ "a.css": ".a{color:red}", "c.css": ".c{color:blue}" });
    const index = await loadCssIndex(source, ["a.css", "b.css", "c.css"], BPS);
    expect([...index.classes.keys()]).toEqual(["a", "c"]);
    expect(index.artifacts).toEqual([
      { code: "css.missing-file", detail: "stylesheet b.css was not found", file: "b.css" },
    ]);
  });

  test("a name listed twice is read once", async () => {
    const source = memorySource({ "a.css": ".a{color:red}" });
    const index = await loadCssIndex(source, ["a.css", "a.css", "a.css"], BPS);
    expect(source.asked).toEqual(["a.css"]);
    expect(index.artifacts).toEqual([]);
  });

  test("every artifact of a loaded file carries its name, a missing file's too, and a merge keeps them", async () => {
    const source = memorySource({
      "a.css": ".undefined{}",
      "b.css": ".b{width:[object Object]px}",
    });
    const index = await loadCssIndex(source, ["a.css", "gone.css", "b.css"], BPS);
    expect(index.artifacts.map((artifact) => [artifact.code, artifact.file])).toEqual([
      ["css.undefined-selector", "a.css"],
      ["css.missing-file", "gone.css"],
      ["css.invalid-value", "b.css"],
    ]);
  });

  test("artifacts found in a file say which file", async () => {
    const source = memorySource({
      "a.css": ".undefined{}",
      "b.css": ".b{width:[object Object]px}",
    });
    const index = await loadCssIndex(source, ["a.css", "b.css"], BPS);
    expect(index.artifacts.map((artifact) => artifact.detail)).toEqual([
      'selector ".undefined" contains "undefined" and the rule is empty (in a.css)',
      'width: invalid value "[object Object]px" (in b.css)',
    ]);
  });

  test("an empty list is an empty index; an empty stylesheet is not missing", async () => {
    const none = await loadCssIndex(memorySource({}), [], BPS);
    expect(none.classes.size + none.artifacts.length).toBe(0);
    const empty = await loadCssIndex(memorySource({ "e.css": "" }), ["e.css"], BPS);
    expect(empty.artifacts).toEqual([]);
  });

  test("a source that throws makes the load throw", async () => {
    const source: CssSource = {
      async get() {
        throw new Error("boom");
      },
    };
    await expect(loadCssIndex(source, ["a.css"], BPS)).rejects.toThrow("boom");
  });

  test("a real page: header, footer and page stylesheets from the fixture, one missing", async () => {
    const index = await loadCssIndex(
      fixtureCssSource("fineline"),
      [
        "cc-global-stylesheets.css",
        "cc-global-classes.css",
        "cc-tp-cwicly_header.css",
        "cc-post-0000000.css",
        "cc-post-5246.css",
      ],
      BPS,
    );
    expect(index.artifacts.filter((a) => a.code === CSS_ARTIFACT.missingFile)).toEqual([
      {
        code: "css.missing-file",
        detail: "stylesheet cc-post-0000000.css was not found",
        file: "cc-post-0000000.css",
      },
    ]);
    expect(index.classes.has("section-default")).toBe(true);
    expect(index.classes.has("nav-ce2259c")).toBe(true);
    expect(index.atRules).toHaveLength(1);
    expect(index.atRules[0]!.key).toStartWith(
      '@import url("https://fonts.googleapis.com/css?family=Reem Kufi',
    );
  });
});

describe("the same class id in two stylesheets (why an index is per page)", () => {
  test("a duplicated page keeps its block ids and changes their styles, so merging posts is wrong", () => {
    const one = parse(readFixtureCss("fineline", "cc-post-1013.css"));
    const two = parse(readFixtureCss("fineline", "cc-post-1078.css"));
    expect(styleOf(one, "section-c7ee2ef")?.["backgroundColor"]).toBe("var(--cc-color-5)");
    expect(styleOf(two, "section-c7ee2ef")?.["backgroundColor"]).toBe("var(--cc-color-1)");
    // Later wins, exactly as it would in a page that loaded both.
    expect(styleOf(mergeCssIndexes(one, two), "section-c7ee2ef")?.["backgroundColor"]).toBe(
      "var(--cc-color-1)",
    );
  });
});

// ── The cascade ──────────────────────────────────────────────────────────────────────────────────
//
// A class's tree keeps the rules of one class together, which is what a block wants and which loses
// the order between classes: `.a{x} .b{y} .a{z}` is `.a{x z} .b{y}`. These tests ask the question a
// browser asks (which declaration wins for an element that carries several classes, at a viewport
// width, in a state) of the original stylesheet and of what the module hands to Jx, using the
// oracle's cascade simulation (`cascadeOf`), which keeps every rule in source order.

const WIDTHS = [1440, 992, 700, 576, 400];
const STATES: readonly (readonly string[])[] = [[], [":hover"]];

interface Subject {
  classes: readonly string[];
  tag?: string;
}

/** Every difference in what the cascade decides for each subject, between two stylesheets (as text). */
function cascadeDifferences(
  original: string,
  rendered: string,
  subjects: readonly Subject[],
  widths: readonly number[] = WIDTHS,
  states: readonly (readonly string[])[] = STATES,
): string[] {
  const expected = analysedRulesOf(original);
  const actual = analysedRulesOf(rendered);
  const out: string[] = [];
  for (const subject of subjects) {
    for (const width of widths) {
      for (const state of states) {
        const query = {
          classes: subject.classes,
          width,
          states: state,
          ...(subject.tag === undefined ? {} : { tag: subject.tag }),
        };
        for (const line of cascadeDiff(cascadeOf(expected, query), cascadeOf(actual, query))) {
          out.push(
            `${subject.tag ?? "div"}.${subject.classes.join(".")} @${width}${state.join("")}: ${line}`,
          );
        }
      }
    }
  }
  return out;
}

/** The class lists of every Cwicly block of every post that has a stylesheet, as the live HTML writes them. */
function realBlocks(site: string): { id: number; lists: string[][] }[] {
  const rows = readFixtureJson<{ ID: number; post_content: string }[]>(site, "rows/posts.json");
  const globals = JSON.parse(fixtureOptionCss(site, "cwicly_global_classes") ?? "{}") as Record<
    string,
    { attributes?: { classID?: string } }
  >;
  const have = new Set(fixtureCssNames(site));
  const posts: { id: number; lists: string[][] }[] = [];
  for (const row of rows) {
    if (!have.has(`cc-post-${row.ID}.css`) || !row.post_content.includes("cwicly/")) continue;
    const seen = new Set<string>();
    const lists: string[][] = [];
    const visit = (blocks: ReturnType<typeof parseBlocks>): void => {
      for (const block of blocks) {
        if (block.blockName?.startsWith("cwicly/")) {
          const attrs = block.attrs as {
            classID?: string;
            globalClass?: string[];
            additionalClassesR?: string;
          };
          const list = [
            attrs.classID,
            ...(attrs.globalClass ?? []).map((id) => globals[id]?.attributes?.classID),
            ...(attrs.additionalClassesR?.split(/\s+/) ?? []),
          ].filter((name): name is string => name !== undefined && name !== "");
          if (!seen.has(list.join(" "))) {
            seen.add(list.join(" "));
            lists.push(list);
          }
        }
        visit(block.innerBlocks);
      }
    };
    visit(parseBlocks(row.post_content));
    posts.push({ id: row.ID, lists });
  }
  return posts;
}

/** The stylesheets a post loads on the live site, in order: the two global ones, then its own. */
const postStylesheets = (id: number): string[] => [
  "cc-global-stylesheets.css",
  "cc-global-classes.css",
  `cc-post-${id}.css`,
];

const concatenated = (site: string, names: readonly string[]): string =>
  names.map((name) => readFixtureCss(site, name)).join("\n");

describe("the cascade oracle itself (so that a green check means something)", () => {
  const winners = (css: string, query: Parameters<typeof cascadeOf>[1]): Record<string, string> =>
    cascadeOf(analysedRulesOf(css), query);

  test("equal specificity: the later rule wins; more specificity wins whatever the order", () => {
    const css = ".a{color:red}.b{color:blue}.a.b{color:green}.c{color:black}";
    expect(winners(css, { classes: ["a", "b"], width: 1000 })["|color"]).toBe("color: green");
    expect(
      winners(".a{color:red}.b{color:blue}", { classes: ["a", "b"], width: 1000 })["|color"],
    ).toBe("color: blue");
    expect(
      winners(".a{color:red}.b{color:blue}", { classes: ["b", "a"], width: 1000 })["|color"],
    ).toBe("color: blue");
    expect(winners(css, { classes: ["a"], width: 1000 })["|color"]).toBe("color: red");
  });

  test("!important beats a later rule, and the later of two !important wins", () => {
    expect(
      winners(".a{color:red!important}.b{color:blue}", { classes: ["a", "b"], width: 1000 })[
        "|color"
      ],
    ).toBe("color: red !important");
    expect(
      winners(".a{color:red!important}.b{color:blue!important}", {
        classes: ["a", "b"],
        width: 1000,
      })["|color"],
    ).toBe("color: blue !important");
  });

  test("a media query applies at the widths it names, and a rule is only as late as its place in the file", () => {
    const css = ".a{color:red}@media screen and (max-width: 992px){.a{color:blue}}.a{margin:0}";
    expect(winners(css, { classes: ["a"], width: 993 })["|color"]).toBe("color: red");
    expect(winners(css, { classes: ["a"], width: 992 })["|color"]).toBe("color: blue");
    expect(winners(css, { classes: ["a"], width: 400 })["|color"]).toBe("color: blue");
    // The base rule that FOLLOWS the media query wins at both widths: order, not context.
    const later = "@media (max-width: 992px){.a{color:blue}}.a{color:red}";
    expect(winners(later, { classes: ["a"], width: 400 })["|color"]).toBe("color: red");
    const min = "@media (min-width: 1000px){.a{color:blue}}";
    expect(winners(min, { classes: ["a"], width: 999 })["|color"]).toBeUndefined();
    expect(winners(min, { classes: ["a"], width: 1000 })["|color"]).toBe("color: blue");
  });

  test("states: a :hover rule applies to a hovered element only", () => {
    const css = ".a{color:red}.a:hover{color:blue}";
    expect(winners(css, { classes: ["a"], width: 1000 })["|color"]).toBe("color: red");
    expect(winners(css, { classes: ["a"], width: 1000, states: [":hover"] })["|color"]).toBe(
      "color: blue",
    );
  });

  test("a shorthand and its longhands answer for each other, by position", () => {
    const after = ".a{padding-top:1px}.a{padding:2px}";
    expect(winners(after, { classes: ["a"], width: 1000 })["|padding-top"]).toBe("padding: 2px");
    const before = ".a{padding:2px}.a{padding-top:1px}";
    expect(winners(before, { classes: ["a"], width: 1000 })["|padding-top"]).toBe(
      "padding-top: 1px",
    );
    expect(winners(before, { classes: ["a"], width: 1000 })["|padding-left"]).toBe("padding: 2px");
    // `gap` is not a prefix of `row-gap`, and still sets it.
    expect(winners(".a{row-gap:1px}.a{gap:2px}", { classes: ["a"], width: 1000 })["|row-gap"]).toBe(
      "gap: 2px",
    );
  });

  test("descendants and pseudo-elements are targets of their own", () => {
    const css = ".a svg{fill:red}.b svg{fill:blue}.a::before{content:'x'}.a:before{color:red}";
    const result = winners(css, { classes: ["a", "b"], width: 1000 });
    expect(result[" svg|fill"]).toBe("fill: blue");
    expect(result["::before|content"]).toBe("content: 'x'");
    expect(result["::before|color"]).toBe("color: red");
    expect(result["|color"]).toBeUndefined();
  });

  test("a tag-qualified rule needs the tag, and `.cls:is(a)` is the same thing", () => {
    expect(winners("a.c{color:red}", { classes: ["c"], width: 1000 })).toEqual({});
    expect(winners("a.c{color:red}", { classes: ["c"], tag: "a", width: 1000 })["|color"]).toBe(
      "color: red",
    );
    expect(
      winners(".c:is(a){color:red}", { classes: ["c"], tag: "a", width: 1000 })["|color"],
    ).toBe("color: red");
    // `a.c` (0,1,1) beats a later `.c` (0,1,0).
    expect(
      winners("a.c{color:red}.c{color:blue}", { classes: ["c"], tag: "a", width: 1000 })["|color"],
    ).toBe("color: red");
  });

  test("it is not vacuous: the module's own class-by-class output differs from the file for `.a{x} .b{y} .a{z}`", () => {
    const css = ".a{position:relative}.b{padding:2rem}.a{padding-top:0px}";
    const tree = renderCssIndex(parse(css), BPS);
    expect(cascadeDifferences(css, tree, [{ classes: ["a", "b"] }], [1000], [[]])).toEqual([
      "div.a.b @1000: |padding-top: padding-top: 0px  ->  padding: 2rem",
    ]);
  });

  test("class names with escapes render as one class, not a class and a pseudo-class", () => {
    expect(classSelector("md:flex")).toBe(".md\\:flex");
    expect(classSelector("123")).toBe(".\\31 23");
    const asClass = canonicalCss(".md\\:flex{color:red}");
    const asPseudo = canonicalCss(".md:flex{color:red}");
    expect(Object.keys(asClass.rules)).toEqual([".md\\:flex"]);
    expect(Object.keys(asPseudo.rules)).toEqual([".md:flex"]);
  });
});

describe("source order across classes (a class's tree cannot carry it; the rules and projectStyles do)", () => {
  const css = ".a{position:relative}.b{padding:2rem}.a{padding-top:0px}";

  test("the trees say what they always said: one entry per class, later declarations merged in", () => {
    const index = parse(css);
    expect(
      Object.fromEntries([...index.classes].map(([name, entry]) => [name, entry.style])),
    ).toEqual({
      a: { position: "relative", paddingTop: "0px" },
      b: { padding: "2rem" },
    });
  });

  test("the index also keeps the rules, in the order of the file", () => {
    const index = parse(css);
    expect(cssRules(index)).toEqual([
      { layer: 0, selector: ".a", context: [], declarations: [["position", "relative"]] },
      { layer: 0, selector: ".b", context: [], declarations: [["padding", "2rem"]] },
      { layer: 0, selector: ".a", context: [], declarations: [["paddingTop", "0px"]] },
    ]);
    expect(index.rules).toBe(cssRules(index));
  });

  test("an element with both classes: the file gives it padding-top 0px; class-by-class output gives it 2rem; the layout gives it 0px", () => {
    const index = parse(css);
    const subject = [{ classes: ["a", "b"] }];
    expect(analysedRulesOf(css)).toBeDefined();
    const expected = cascadeOf(analysedRulesOf(css), { classes: ["a", "b"], width: 1000 });
    expect(expected["|padding-top"]).toBe("padding-top: 0px");
    // What emitting `classes` one after the other does (the defect the layout exists to avoid):
    expect(cascadeDifferences(css, renderCssIndex(index, BPS), subject, [1000], [[]])).not.toEqual(
      [],
    );
    // What `projectStyles` does:
    expect(cascadeDifferences(css, renderCascade(index, BPS), subject, WIDTHS)).toEqual([]);
  });

  test("it takes two stylesheets, because `.a`'s second rule cannot go before `.b`'s rule and still be after it", () => {
    expect(projectStyles(parse(css), BPS)).toEqual([
      { ".a": { position: "relative" }, ".b": { padding: "2rem" } },
      { ".a": { paddingTop: "0px" } },
    ]);
  });

  test("a file in the order Cwicly writes is one stylesheet: base rules first, then each breakpoint's", () => {
    const text =
      ".a{color:red}.b{margin:0}@media screen and (max-width: 992px){.a{color:blue}.b{margin:1px}}@media screen and (max-width: 576px){.a{color:green}}";
    expect(projectStyles(parse(text), BPS)).toEqual([
      {
        ".a": { color: "red" },
        ".b": { margin: "0" },
        "@--md": { ".a": { color: "blue" }, ".b": { margin: "1px" } },
        "@--sm": { ".a": { color: "green" } },
      },
    ]);
  });

  test("the breakpoint blocks come in cascade order whatever order they first appeared in", () => {
    const text =
      "@media screen and (max-width: 576px){.a{margin:0}}@media screen and (max-width: 992px){.a{color:blue}}";
    // The narrower query was written first. Nothing in the two rules can override the other, so they
    // come out in the order that makes the narrower one win where both apply: md, then sm.
    expect(Object.keys(projectStyles(parse(text), BPS)[0]!)).toEqual(["@--md", "@--sm"]);
    const withMin: Breakpoint[] = [
      { key: "xl", width: 1920, isMain: false, direction: "min" },
      ...BPS,
    ];
    const wide = parse(
      "@media screen and (max-width: 992px){.a{margin:0}}@media screen and (min-width: 1920px){.a{color:red}}",
      withMin,
    );
    expect(Object.keys(projectStyles(wide, withMin)[0]!)).toEqual(["@--xl", "@--md"]);
    // Without the breakpoints it cannot know, and keeps the order of first appearance.
    expect(Object.keys(projectStyles(wide)[0]!)).toEqual(["@--md", "@--xl"]);
  });

  test("a file that writes the narrower breakpoint first, over the same property, is laid out as several stylesheets and stays exact", () => {
    const text =
      "@media screen and (max-width: 576px){.a{color:green}}@media screen and (max-width: 992px){.a{color:blue}}.a{color:red}";
    const index = parse(text);
    expect(projectStyles(index, BPS)).toEqual([
      { "@--sm": { ".a": { color: "green" } } },
      { "@--md": { ".a": { color: "blue" } } },
      { ".a": { color: "red" } },
    ]);
    expect(cascadeDifferences(text, renderCascade(index, BPS), [{ classes: ["a"] }])).toEqual([]);
  });

  test("class names are escaped in the selector keys, and `other` rules are keyed as they are", () => {
    const [sheet] = projectStyles(
      parse(".md\\:flex{display:flex}body{margin:0}.a.b:hover{color:red}"),
      BPS,
    );
    expect(Object.keys(sheet!)).toEqual([".md\\:flex", "body", ".a.b:hover"]);
  });

  test("nested keys become selectors of their own, in the order the rules were written", () => {
    const [sheet] = projectStyles(
      parse(".a{color:red}.a:hover{color:blue}.a svg{fill:red}a.a::before{content:'x'}"),
      BPS,
    );
    // `a.a::before` is the class `a` qualified by a tag: the reader files it as `&:is(a)::before`.
    expect(Object.keys(sheet!)).toEqual([".a", ".a:hover", ".a svg", ".a:is(a)::before"]);
  });

  test("an index with no rules of its own (built by hand) is laid out from its trees", () => {
    const byHand: CssIndex = {
      classes: new Map([
        [
          "a",
          { style: { color: "red", ":hover": { color: "blue" }, "@--md": { color: "green" } } },
        ],
      ]),
      other: new Map([["body", { margin: "0" }]]),
      atRules: [],
      artifacts: [],
    };
    expect(
      cssRules(byHand).map((part) => [part.selector, part.context, part.declarations]),
    ).toEqual([
      [".a", [], [["color", "red"]]],
      [".a:hover", [], [["color", "blue"]]],
      [".a", ["@--md"], [["color", "green"]]],
      ["body", [], [["margin", "0"]]],
    ]);
    expect(projectStyles(byHand, BPS)).toEqual([
      {
        ".a": { color: "red" },
        ".a:hover": { color: "blue" },
        body: { margin: "0" },
        "@--md": { ".a": { color: "green" } },
      },
    ]);
  });

  test("a query that names no breakpoint, or a type, is a block of its own and renders as the file says", () => {
    const text =
      ".a{color:red}@media (min-width: 40rem) and (max-width: 60rem){.a{color:blue}}@media print{.a{color:green}}";
    const index = parse(text);
    expect(Object.keys(projectStyles(index, BPS)[0]!)).toEqual([
      ".a",
      "@(min-width: 40rem) and (max-width: 60rem)",
      "@(print)",
    ]);
    // 40rem is 640px and 60rem 960px: inside at 700, outside at 400 and 1000. Print never applies.
    expect(
      cascadeDifferences(text, renderCascade(index, BPS), [{ classes: ["a"] }], [400, 700, 1000]),
    ).toEqual([]);
    expect(cascadeOf(analysedRulesOf(text), { classes: ["a"], width: 700 })["|color"]).toBe(
      "color: blue",
    );
  });

  test("a rule that two selectors share is one rule for each, in the order of the list", () => {
    const [sheet] = projectStyles(parse(".a,.b>.c{color:red}"), BPS);
    expect(sheet).toEqual({ ".a": { color: "red" }, ".b > .c": { color: "red" } });
  });

  describe("declarations that cannot override one another do not force a new stylesheet", () => {
    test("different properties", () => {
      expect(projectStyles(parse(".a{color:red}.b{margin:0}.a{padding:0}"), BPS)).toHaveLength(1);
    });
    test("but a shorthand that sets another property too is related to it: `font` and `line-height`", () => {
      expect(
        projectStyles(parse(".a{line-height:2}.b{font:12px Arial}.a{line-height:3}"), BPS),
      ).toHaveLength(2);
      // `font-style` is a longhand of `font`, not a relative of `line-height`.
      expect(
        projectStyles(parse(".a{line-height:2}.b{font-style:italic}.a{line-height:3}"), BPS),
      ).toHaveLength(1);
      expect(
        projectStyles(parse(".a{font-style:italic}.b{font:12px Arial}.a{font-style:normal}"), BPS),
      ).toHaveLength(2);
      expect(
        projectStyles(parse(".a{line-height:2}.b{color:red}.a{line-height:3}"), BPS),
      ).toHaveLength(1);
    });
    test("different specificity: the more specific selector wins whatever the order", () => {
      expect(
        projectStyles(parse(".a{color:red}.b.c{color:blue}.a{margin:0}.a{color:green}"), BPS),
      ).toHaveLength(1);
    });
    test("selectors for different element types (`a` and `p`) cannot meet on one element", () => {
      expect(
        projectStyles(parse(".x a{color:red}.x p{color:blue}.x a{color:green}"), BPS),
      ).toHaveLength(1);
      // Two selectors for the same type, of equal specificity, can.
      expect(
        projectStyles(parse(".x a{color:red}.y a{color:blue}.x a{color:green}"), BPS),
      ).toHaveLength(2);
    });
    test("an !important declaration is not overridden by a later plain one, and the reverse", () => {
      expect(
        projectStyles(
          parse(".a{color:red!important}.b{color:blue}.a{margin:0;color:green!important}"),
          BPS,
        ),
      ).toHaveLength(1);
      expect(
        projectStyles(
          parse(".a{color:red!important}.b{color:blue!important}.a{color:green!important}"),
          BPS,
        ),
      ).toHaveLength(2);
    });
    test("a pseudo-element is a different target from the element", () => {
      expect(
        projectStyles(
          parse(".a{color:red}.b::before{color:blue}.a{margin:0}.a::before{color:green}"),
          BPS,
        ),
      ).toHaveLength(1);
    });
  });

  test("a base rule that follows a responsive rule for the same property is a stylesheet of its own (and exact)", () => {
    const text = "@media screen and (max-width: 992px){.x{color:green}}.x{color:red}";
    const index = parse(text);
    expect(projectStyles(index, BPS)).toEqual([
      { "@--md": { ".x": { color: "green" } } },
      { ".x": { color: "red" } },
    ]);
    // In the file the base rule wins at every width; a tree emits it first and lets the media rule win.
    expect(cascadeDifferences(text, renderCascade(index, BPS), [{ classes: ["x"] }])).toEqual([]);
    expect(cascadeDifferences(text, renderCssIndex(index, BPS), [{ classes: ["x"] }])).not.toEqual(
      [],
    );
  });

  test("the same layout is exact for hover rules and for a descendant of a class with a media rule first", () => {
    const text =
      ".btn{background:blue}@media screen and (max-width: 992px){.btn{padding:4px}}.btn:hover{background:red}@media screen and (max-width: 992px){.btn:hover{background:green}}";
    const index = parse(text);
    expect(cascadeDifferences(text, renderCascade(index, BPS), [{ classes: ["btn"] }])).toEqual([]);
    expect(
      cascadeOf(analysedRulesOf(text), { classes: ["btn"], width: 700, states: [":hover"] })[
        "|background"
      ],
    ).toBe("background: green");
  });
});

describe("source order across stylesheets (mergeCssIndexes and loadCssIndex keep one layer per file)", () => {
  const a = ".a{color:red}@media screen and (max-width: 992px){.a{color:blue}}";
  const b = ".a{color:green}";

  test("the merged tree says the later file wins, and emits its base rule before the earlier file's media rule", () => {
    const merged = mergeCssIndexes(parse(a), parse(b));
    expect(styleOf(merged, "a")).toEqual({ color: "green", "@--md": { color: "blue" } });
    // At 800px the file `a` + `b` is green (b's base rule is the last word); the tree's emission is blue.
    const together = `${a}${b}`;
    expect(cascadeOf(analysedRulesOf(together), { classes: ["a"], width: 800 })["|color"]).toBe(
      "color: green",
    );
    expect(
      cascadeDifferences(together, renderCssIndex(merged, BPS), [{ classes: ["a"] }]),
    ).not.toEqual([]);
  });

  test("the merged rules keep the files apart, one layer each, and projectStyles emits them one after the other", () => {
    const merged = mergeCssIndexes(parse(a), parse(b));
    expect(merged.rules.map((part) => part.layer)).toEqual([0, 0, 1]);
    expect(projectStyles(merged, BPS)).toEqual([
      { ".a": { color: "red" }, "@--md": { ".a": { color: "blue" } } },
      { ".a": { color: "green" } },
    ]);
    const together = `${a}${b}`;
    expect(cascadeDifferences(together, renderCascade(merged, BPS), [{ classes: ["a"] }])).toEqual(
      [],
    );
  });

  test("a file boundary is a stylesheet boundary even where nothing could override anything", () => {
    const merged = mergeCssIndexes(parse(".a{color:red}"), parse(".b{margin:0}"));
    expect(projectStyles(merged, BPS)).toEqual([
      { ".a": { color: "red" } },
      { ".b": { margin: "0" } },
    ]);
    // Within one file the same two rules share a stylesheet.
    expect(projectStyles(parse(".a{color:red}.b{margin:0}"), BPS)).toHaveLength(1);
  });

  test("layers keep counting across merges of merges, and an empty or rule-less input takes none", () => {
    const one = mergeCssIndexes(parse(".a{color:red}"), parse(".b{color:red}"));
    const two = mergeCssIndexes(
      one,
      emptyCssIndex(),
      parse(".c{color:red}"),
      parse(".undefined{}"),
      parse(".d{color:red}"),
    );
    expect(two.rules.map((part) => [part.selector, part.layer])).toEqual([
      [".a", 0],
      [".b", 1],
      [".c", 2],
      [".d", 3],
    ]);
  });

  test("loadCssIndex: one layer per file, in the order given", async () => {
    const source = memorySource({ "one.css": a, "two.css": b });
    const index = await loadCssIndex(source, ["one.css", "two.css"], BPS);
    expect(index.rules.map((part) => part.layer)).toEqual([0, 0, 1]);
    const reversed = await loadCssIndex(source, ["two.css", "one.css"], BPS);
    expect(reversed.rules.map((part) => [part.selector, part.layer])).toEqual([
      [".a", 0],
      [".a", 1],
      [".a", 1],
    ]);
  });

  test("merging does not change the inputs' rules or share them with the result", () => {
    const one = parse(".a{color:red}");
    const merged = mergeCssIndexes(one);
    expect(merged.rules).toEqual(one.rules);
    expect(merged.rules[0]).not.toBe(one.rules[0]);
    expect(merged.rules[0]!.declarations).not.toBe(one.rules[0]!.declarations);
  });
});

describe("source order over the real corpus", () => {
  test("global classes, every pair on one element: the layout is the file's cascade; class-by-class output is not", () => {
    const wrong = { fineline: 0, ap: 0 };
    for (const site of FIXTURE_SITES) {
      const css = readFixtureCss(site, "cc-global-classes.css");
      const index = parsed(css);
      const names = [...index.classes.keys()];
      const pairs: Subject[] = [];
      for (const [i, first] of names.entries()) {
        for (const second of names.slice(i + 1)) pairs.push({ classes: [first, second] });
      }
      expect(pairs).toHaveLength((names.length * (names.length - 1)) / 2);
      expect(cascadeDifferences(css, renderCascade(index, BPS), pairs)).toEqual([]);
      const tree = renderCssIndex(index, BPS);
      wrong[site as "fineline" | "ap"] = pairs.filter(
        (pair) => cascadeDifferences(css, tree, [pair]).length > 0,
      ).length;
    }
    // Of 378 and 1,326 pairs, the ones whose cascade a per-class emission changes (descendants count,
    // so this is a few more than a browser shows on a bare element).
    expect(wrong).toEqual({ fineline: 37, ap: 51 });
  });

  test("how many stylesheets each real file needs: one, nearly always", () => {
    const sheets = new Map<number, string[]>();
    for (const { site, name, css } of REAL) {
      const count = projectStyles(parsed(css), BPS).length;
      sheets.set(count, [...(sheets.get(count) ?? []), `${site}/${name}`]);
    }
    expect([...sheets.keys()].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 11]);
    expect(sheets.get(0)!.length).toBe(16);
    expect(sheets.get(1)!.length).toBe(131);
    expect(sheets.get(2)).toEqual([
      "fineline/cc-post-1714.css",
      "fineline/cc-post-5246.css",
      "fineline/cc-tp-cwicly_archive-project.css",
      "fineline/cc-tp-cwicly_header.css",
      "fineline/cc-tp-cwicly_single-project.css",
      "ap/cc-global-classes.css",
    ]);
    expect(sheets.get(3)).toEqual(["fineline/cc-global-classes.css"]);
    expect(sheets.get(11)).toEqual(["ap/cc-main.css"]);
  });

  for (const site of FIXTURE_SITES) {
    test(`${site}: every block of every post (its classID, global classes and additional classes), at five widths, hovered or not`, async () => {
      const source = fixtureCssSource(site);
      const posts = realBlocks(site);
      expect(posts.length).toBe(site === "fineline" ? 91 : 13);
      let lists = 0;
      const treeDiffers: number[] = [];
      for (const post of posts) {
        const names = postStylesheets(post.id);
        const original = concatenated(site, names);
        const index = await loadCssIndex(source, names, BPS);
        const subjects = post.lists.map((classes) => ({ classes }));
        lists += subjects.length;
        expect({
          post: post.id,
          diffs: cascadeDifferences(original, renderCascade(index, BPS), subjects).slice(0, 4),
        }).toEqual({
          post: post.id,
          diffs: [],
        });
        if (cascadeDifferences(original, renderCssIndex(index, BPS), subjects).length > 0) {
          treeDiffers.push(post.id);
        }
      }
      expect(lists).toBeGreaterThan(site === "fineline" ? 4000 : 400);
      // The two posts the first report found, for which class-by-class output is wrong at <=576px:
      // `.columns-c3975bf` (padding-top: 0px) and `.featured-columns` (padding: 2rem at 576).
      expect(treeDiffers).toEqual(site === "fineline" ? [5270, 5297] : []);
    });
  }

  test("post 5297 (Shutter Painting): `columns-c3975bf featured-columns` at 576px", async () => {
    const names = postStylesheets(5297);
    const original = concatenated("fineline", names);
    const index = await loadCssIndex(fixtureCssSource("fineline"), names, BPS);
    // In the file `.featured-columns{padding:2rem}` (its @media 576 rule) is LATER than
    // `.columns-c3975bf{padding-top:0px}`, so at 576 the padding is 2rem all round: 32px, as on the live site.
    const winner = (width: number): string | undefined =>
      cascadeOf(analysedRulesOf(original), {
        classes: ["columns-c3975bf", "featured-columns"],
        width,
      })["|padding-top"];
    expect(winner(1440)).toBe("padding-top: 0px");
    expect(winner(576)).toBe("padding: 2rem");
    const subject = [{ classes: ["columns-c3975bf", "featured-columns"] }];
    expect(cascadeDifferences(original, renderCascade(index, BPS), subject)).toEqual([]);
    expect(cascadeDifferences(original, renderCssIndex(index, BPS), subject, [576], [[]])).toEqual([
      "div.columns-c3975bf.featured-columns @576: |padding-top: padding: 2rem  ->  padding-top: 0px",
    ]);
  });

  test("post 5270 (Kitchens): `heading-c16084e featured-heading` at 576px", async () => {
    const names = postStylesheets(5270);
    const original = concatenated("fineline", names);
    const index = await loadCssIndex(fixtureCssSource("fineline"), names, BPS);
    const subject = [{ classes: ["heading-c16084e", "featured-heading"] }];
    expect(cascadeDifferences(original, renderCascade(index, BPS), subject)).toEqual([]);
    const treeLines = cascadeDifferences(original, renderCssIndex(index, BPS), subject);
    expect(treeLines.length).toBeGreaterThan(0);
    expect(treeLines.every((line) => line.includes("@576") || line.includes("@400"))).toBe(true);
    expect(
      treeLines.some((line) => line.includes("margin-bottom") || line.includes("padding-bottom")),
    ).toBe(true);
  });

  for (const site of FIXTURE_SITES) {
    const pages = readdirSync(join(fixtureDir(site), "html"))
      .filter((file) => file.endsWith(".html"))
      .sort();
    for (const file of pages) {
      test(`${site}/${file}: every element the live page renders, by its tag and classes`, async () => {
        const html = readFixtureText(site, `html/${file}`);
        const names = [
          ...html.matchAll(
            /<link[^>]+href=['"][^'"]*\/uploads\/cwicly\/(?:css\/)?(cc-[^?'"]+)[?'"]/g,
          ),
        ].map((match) => match[1]!);
        const index = await loadCssIndex(fixtureCssSource(site), names, BPS);
        const original = concatenated(site, names);
        const seen = new Set<string>();
        const subjects: Subject[] = [];
        for (const match of html.matchAll(/<([a-z][a-z0-9-]*)\b[^>]*?\sclass=["']([^"']*)["']/gi)) {
          const classes = match[2]!.split(/\s+/).filter((name) => name !== "");
          const key = `${match[1]!.toLowerCase()} ${classes.join(" ")}`;
          if (seen.has(key)) continue;
          seen.add(key);
          subjects.push({ tag: match[1]!.toLowerCase(), classes });
        }
        expect(subjects.length).toBeGreaterThan(50);
        expect(
          cascadeDifferences(original, renderCascade(index, BPS), subjects).slice(0, 5),
        ).toEqual([]);
      });
    }
  }
});

// ── The order of keys inside a tree ──────────────────────────────────────────────────────────────

describe("a class's tree is in the order Jx emits it: own declarations, nested selectors, then at-rules", () => {
  /** The paths of every key that breaks the order, at any depth. */
  function misplaced(style: JxStyle, path: string[] = []): string[] {
    const found: string[] = [];
    let highest = 0;
    for (const [key, value] of Object.entries(style)) {
      const rank = !isBlock(value) ? 0 : key.startsWith("@") ? 2 : 1;
      if (rank < highest) found.push([...path, key].join(" > "));
      highest = Math.max(highest, rank);
      if (isBlock(value)) found.push(...misplaced(value, [...path, key]));
    }
    return found;
  }
  const violations = (index: CssIndex): string[] => [
    ...[...index.classes].flatMap(([name, entry]) => misplaced(entry.style, [`.${name}`])),
    ...[...index.other].flatMap(([selector, style]) => misplaced(style, [selector])),
  ];

  test("in every real file and compiled option: nothing but at-rules follows an at-rule", () => {
    const bad: Record<string, string[]> = {};
    for (const { site, name, css } of [...REAL, ...OPTION_CSS]) {
      const found = violations(parsed(css));
      if (found.length > 0) bad[`${site}/${name}`] = found;
    }
    expect(bad).toEqual({});
  });

  test("and in every page's merged index (two files, each opening a block the other fills later)", async () => {
    for (const site of FIXTURE_SITES) {
      for (const file of readdirSync(join(fixtureDir(site), "html")).filter((f) =>
        f.endsWith(".html"),
      )) {
        const html = readFixtureText(site, `html/${file}`);
        const names = [
          ...html.matchAll(
            /<link[^>]+href=['"][^'"]*\/uploads\/cwicly\/(?:css\/)?(cc-[^?'"]+)[?'"]/g,
          ),
        ].map((match) => match[1]!);
        expect({
          page: `${site}/${file}`,
          bad: violations(await loadCssIndex(fixtureCssSource(site), names, BPS)),
        }).toEqual({
          page: `${site}/${file}`,
          bad: [],
        });
      }
    }
  });

  test("the real files that open a breakpoint block before their base rules: fineline's global classes and header", () => {
    // `.unknown-class` starts with `@media (max-width: 992px){.unknown-class .cc-nav-toggle…}` and then writes `& p`, `& a`.
    const classes = parsed(readFixtureCss("fineline", "cc-global-classes.css"));
    expect(Object.keys(styleOf(classes, "unknown-class")!)).toEqual([
      "color",
      "& :is((h1,h2,h3,h4,h5,h6))",
      "& p",
      "& a",
      "&:is(a) :is((h1,h2,h3,h4,h5,h6))",
      "& :is((h1,h2,h3,h4,h5,h6)):hover",
      "& p:hover",
      "& a:hover",
      "&:is(a) :is((h1,h2,h3,h4,h5,h6)):hover",
      "@--md",
    ]);
    const header = parsed(readFixtureCss("fineline", "cc-tp-cwicly_header.css"));
    // `.nav-ce2259c`'s own declarations come before its breakpoint block, though the file wrote that first.
    const keys = Object.keys(styleOf(header, "nav-ce2259c")!);
    expect(keys.indexOf("position")).toBeLessThan(keys.indexOf("@--md"));
    expect(keys.indexOf("display")).toBeLessThan(keys.indexOf("@--md"));
  });

  test("every class of every real file, alone on an element: class-by-class output is the file's cascade", () => {
    const bad: string[] = [];
    let checked = 0;
    for (const { site, name, css } of [...REAL, ...OPTION_CSS]) {
      const index = parsed(css);
      const rendered = renderCssIndex(index, BPS);
      const subjects = [...index.classes.keys()].map((cls) => ({ classes: [cls] }));
      checked += subjects.length;
      for (const line of cascadeDifferences(
        css,
        rendered,
        subjects,
        [1440, 992, 576],
        [[], [":hover"]],
      ).slice(0, 3)) {
        bad.push(`${site}/${name}: ${line}`);
      }
    }
    expect(checked).toBeGreaterThan(4000);
    expect(bad).toEqual([]);
  });

  test("a negative control: a nested selector moved behind a breakpoint block is noticed", () => {
    // The nav shape of the real header files: a breakpoint rule opens the class, base rules follow.
    const css =
      "@media screen and (max-width: 992px){.n .t{display:block}}.n .i{font-size:16px}@media screen and (max-width: 992px){.n .i{font-size:18px}}";
    const index = mergeCssIndexes(parse(css));
    expect(cascadeDifferences(css, renderCssIndex(index, BPS), [{ classes: ["n"] }])).toEqual([]);
    const style = styleOf(index, "n")!;
    const moved: JxStyle = { "@--md": style["@--md"]!, "& .i": style["& .i"]! };
    expect(Object.keys(moved)).toEqual(["@--md", "& .i"]);
    const broken: CssIndex = { ...index, classes: new Map([["n", { style: moved }]]) };
    expect(
      cascadeDifferences(css, renderCssIndex(broken, BPS), [{ classes: ["n"] }]).length,
    ).toBeGreaterThan(0);
  });

  describe("a breakpoint block opened early by a rule for one selector must not outrank the base rules written after it", () => {
    // Verbatim from littlecocalico's cc-tp-cwicly_header.css (the third real site, not a fixture): the
    // rules for `.nav-c8c42d8` in file order. The `@media` rule at byte 0 opens the class's breakpoint
    // block; `.cc-nav-item` and `.cc-nav__section` are written at the main breakpoint 2 KB later and
    // overridden in the breakpoint block at byte 23623. Their base rules were being emitted AFTER it.
    const header =
      "@media screen and (max-width: 992px){.nav-c8c42d8 .cc-nav-toggle:not(.cc-hamburger){height: 48px;width: 48px;display: flex;justify-content: center;align-items: center;}}" +
      ".nav-c8c42d8 .cc-nav-item{font-size:16px;font-weight:500;-moz-column-gap:0.5rem;column-gap:0.5rem;display:flex;}" +
      ".nav-c8c42d8 .cc-nav__section{-moz-column-gap:3rem;column-gap:3rem;display:flex;flex-direction:row;}" +
      ".nav-c8c42d8 .cc-nav__section{padding:2rem;}" +
      ".nav-c8c42d8{align-items:stretch;display:flex;flex-direction:column;width:100%;--cc-nav-db-color: #ffffff;--cc-nav-caret-color: #ffffff;}" +
      "@media screen and (max-width: 992px){.nav-c8c42d8 .cc-nav-item{font-size:18px;line-height:40px;}.nav-c8c42d8 .cc-nav__section{display:flex;flex-direction:column;}}";
    const index = parse(header);

    test("the file's cascade: at 992px the breakpoint rules win", () => {
      const at = (width: number): Record<string, string> =>
        cascadeOf(analysedRulesOf(header), { classes: ["nav-c8c42d8"], width });
      expect(at(1440)[" .cc-nav-item|font-size"]).toBe("font-size: 16px");
      expect(at(992)[" .cc-nav-item|font-size"]).toBe("font-size: 18px");
      expect(at(992)[" .cc-nav__section|flex-direction"]).toBe("flex-direction: column");
    });

    test("the tree keeps the base rules ahead of the breakpoint block, so class-by-class output agrees", () => {
      expect(Object.keys(styleOf(index, "nav-c8c42d8")!)).toEqual([
        "alignItems",
        "display",
        "flexDirection",
        "width",
        "--cc-nav-db-color",
        "--cc-nav-caret-color",
        "& .cc-nav-item",
        "& .cc-nav__section",
        "@--md",
      ]);
      expect(
        cascadeDifferences(header, renderCssIndex(index, BPS), [{ classes: ["nav-c8c42d8"] }]),
      ).toEqual([]);
      expect(
        cascadeDifferences(header, renderCascade(index, BPS), [{ classes: ["nav-c8c42d8"] }]),
      ).toEqual([]);
    });
  });

  test("plausible hand-written CSS: a hover rule written between two breakpoint rules", () => {
    const css =
      ".btn{background:blue}@media screen and (max-width: 992px){.btn{padding:4px}}.btn:hover{background:red}@media screen and (max-width: 992px){.btn:hover{background:green}}";
    const index = parse(css);
    const hovered = { classes: ["btn"] };
    // At 700px, hovered, the file gives green: the media hover rule is the last word.
    expect(
      cascadeOf(analysedRulesOf(css), { ...hovered, width: 700, states: [":hover"] })[
        "|background"
      ],
    ).toBe("background: green");
    expect(cascadeDifferences(css, renderCssIndex(index, BPS), [hovered])).toEqual([]);
    expect(Object.keys(styleOf(index, "btn")!)).toEqual(["background", ":hover", "@--md"]);
  });

  describe("a shorthand and its longhands keep the order they were written in", () => {
    test("`padding-top`, then `padding`, then `padding-top` again", () => {
      const css = ".a{padding-top:1px}.a{padding:2px}.a{padding-top:3px}";
      const index = parse(css);
      // The file's last word on the top padding is the last `padding-top`.
      expect(cascadeOf(analysedRulesOf(css), { classes: ["a"], width: 1000 })["|padding-top"]).toBe(
        "padding-top: 3px",
      );
      expect(Object.keys(styleOf(index, "a")!)).toEqual(["padding", "paddingTop"]);
      expect(cascadeDifferences(css, renderCssIndex(index, BPS), [{ classes: ["a"] }])).toEqual([]);
    });

    test("`padding`, then `padding-top`, then `padding` again resets the top", () => {
      const css = ".a{padding:1px}.a{padding-top:2px}.a{padding:3px}";
      const index = parse(css);
      expect(cascadeOf(analysedRulesOf(css), { classes: ["a"], width: 1000 })["|padding-top"]).toBe(
        "padding: 3px",
      );
      expect(cascadeDifferences(css, renderCssIndex(index, BPS), [{ classes: ["a"] }])).toEqual([]);
    });

    test("shorthands with longhands that do not share their name: `gap` and `row-gap`, `border-color` and `border-top-color`", () => {
      for (const css of [
        ".a{row-gap:1px}.a{gap:2px}.a{row-gap:3px}",
        ".a{border-top-color:red}.a{border-color:blue}.a{border-top-color:green}",
        ".a{top:1px}.a{inset:2px}.a{top:3px}",
      ]) {
        expect(
          cascadeDifferences(css, renderCssIndex(parse(css), BPS), [{ classes: ["a"] }]),
        ).toEqual([]);
      }
    });

    test("an unrelated property is replaced in place, as before", () => {
      const index = parse(".a{color:red;margin:0}.a{color:blue}");
      expect(Object.keys(styleOf(index, "a")!)).toEqual(["color", "margin"]);
    });

    test("the same holds when two files meet in a merge", () => {
      const merged = mergeCssIndexes(
        parse(".a{padding-top:1px;color:red}"),
        parse(".a{padding:2px}"),
        parse(".a{padding-top:3px}"),
      );
      expect(Object.keys(styleOf(merged, "a")!)).toEqual(["color", "padding", "paddingTop"]);
    });

    test("custom properties and vendor-prefixed properties are never mistaken for shorthands of each other", () => {
      const index = parse(
        ".a{--padding:1px;--padding-top:2px}.a{--padding:3px}.a{-webkit-box-orient:vertical;-webkit-box-pack:end}.a{-webkit-box-orient:horizontal}",
      );
      expect(Object.keys(styleOf(index, "a")!)).toEqual([
        "--padding",
        "--padding-top",
        "WebkitBoxOrient",
        "WebkitBoxPack",
      ]);
    });
  });

  describe("css.cascade-order: a base rule after a responsive rule for the same property cannot be a tree", () => {
    const css = "@media screen and (max-width: 992px){.x{color:green}}.x{color:red}";

    test("it is reported, once, with both values and the context", () => {
      const index = parse(css);
      expect(index.artifacts).toEqual([
        {
          code: "css.cascade-order",
          selector: ".x",
          detail:
            'color: ".x" sets "red" after @--md set "green"; a class tree emits base rules before responsive ones, so there @--md keeps "green" (`projectStyles` keeps the file\'s order)',
        },
      ]);
      expect(styleOf(index, "x")).toEqual({ color: "red", "@--md": { color: "green" } });
    });

    test("the nested selector and the property are named as written", () => {
      const index = parse(
        "@media screen and (max-width: 992px){.x:hover{background-color:green}.x svg{--c:1}}.x:hover{background-color:red}.x svg{--c:2}",
      );
      expect(index.artifacts.map((a) => [a.selector, a.detail.split(":")[0]])).toEqual([
        [".x:hover", "background-color"],
        [".x svg", "--c"],
      ]);
    });

    test("nothing is reported when the later rule says the same, sets another property, or comes first", () => {
      for (const quiet of [
        "@media screen and (max-width: 992px){.x{color:red}}.x{color:red}",
        "@media screen and (max-width: 992px){.x{color:green}}.x{margin:0}",
        ".x{color:red}@media screen and (max-width: 992px){.x{color:green}}",
        "@media screen and (max-width: 992px){.x{color:green}}.y{color:red}",
      ]) {
        expect(parse(quiet).artifacts).toEqual([]);
      }
    });

    test("a file merged from several is judged file by file: a later file's base rule is the layout's business, not a defect", () => {
      const merged = mergeCssIndexes(
        parse("@media screen and (max-width: 992px){.x{color:green}}"),
        parse(".x{color:red}"),
      );
      expect(merged.artifacts).toEqual([]);
    });

    test("the real corpus has none (the generator writes base rules first)", () => {
      for (const { css } of REAL) {
        expect(parsed(css).artifacts.filter((a) => a.code === CSS_ARTIFACT.cascadeOrder)).toEqual(
          [],
        );
      }
    });

    test("it is exact in the layout, which puts the later base rule in a stylesheet of its own", () => {
      expect(cascadeDifferences(css, renderCascade(parse(css), BPS), [{ classes: ["x"] }])).toEqual(
        [],
      );
    });
  });
});

// ── Declarations a browser discards ──────────────────────────────────────────────────────────────

describe("a declaration a browser discards never reaches the index (it would replace a valid one)", () => {
  /** `property: reason` of every invalid-value artifact that has a reason (the `undefined` and `[object Object]` ones have none). */
  const reasons = (index: CssIndex): string[] =>
    index.artifacts
      .filter((a) => a.code === CSS_ARTIFACT.invalidValue && a.detail.includes('" ('))
      .map(
        (a) =>
          `${a.detail.slice(0, a.detail.indexOf(":"))}: ${a.detail.slice(a.detail.lastIndexOf('" (') + 3, -1)}`,
      );

  test("an empty value after a valid one: the valid one stays (`column-gap:10px` then `column-gap: ;`)", () => {
    const index = parse(".a{column-gap:10px}.a{column-gap: ;}");
    expect(styleOf(index, "a")).toEqual({ columnGap: "10px" });
    expect(reasons(index)).toEqual(["column-gap: the value is empty"]);
    expect(index.artifacts[0]).toEqual({
      code: "css.invalid-value",
      selector: ".a",
      detail: 'column-gap: invalid value "" (the value is empty)',
    });
  });

  test("an empty function argument after a valid value: the valid one stays", () => {
    const index = parse(
      ".a{display:grid;width:300px;grid-template-columns:1fr 1fr}.a{grid-template-columns: repeat(auto-fit, minmax(, 1fr))}",
    );
    expect(styleOf(index, "a")).toEqual({
      display: "grid",
      width: "300px",
      gridTemplateColumns: "1fr 1fr",
    });
    expect(reasons(index)).toEqual([
      "grid-template-columns: minmax() starts with an empty argument",
    ]);
  });

  test("in a breakpoint, the shape of littlecocalico's cc-post-24456 (the value in force at 992px is kept)", () => {
    const index = parse(
      ".querytemplate-c56f57c{display:grid;grid-template-columns:repeat(auto-fit, minmax(325px, 1fr))}@media screen and (max-width: 992px){.querytemplate-c56f57c{grid-template-columns:1fr 1fr}.querytemplate-c56f57c{grid-template-columns: repeat(auto-fit, minmax(, 1fr))}}",
    );
    expect(styleOf(index, "querytemplate-c56f57c")).toEqual({
      display: "grid",
      gridTemplateColumns: "repeat(auto-fit, minmax(325px, 1fr))",
      "@--md": { gridTemplateColumns: "1fr 1fr" },
    });
    expect(index.artifacts).toHaveLength(1);
  });

  test("each shape, and each one that looks like it but is valid", () => {
    const bad: [string, string][] = [
      ["a{width: }", "the value is empty"],
      ["a{width:\n\t}", "the value is empty"],
      ["a{background-image:}", "the value is empty"],
      ["a{width:calc()}", "calc() has no arguments"],
      ["a{width:calc( )}", "calc() has no arguments"],
      ["a{width:rgb(1,2,)}", "rgb() ends with an empty argument"],
      ["a{width:rgb(,1,2)}", "rgb() starts with an empty argument"],
      ["a{width:rgb(1,,2)}", "rgb() has an empty argument"],
      ["a{width:var(,x)}", "var() starts with an empty argument"],
      ["a{width:var()}", "var() has no arguments"],
      ["a{width:calc(1px + minmax(,1fr))}", "minmax() starts with an empty argument"],
      ["a{margin:0px!important 2px}", "`!important` in the middle of the value"],
      ["a{margin:0 ! important 2px}", "`!important` in the middle of the value"],
      ["a{border-color:var(u002du002dcc-color-1)}", "`u002d` stands where `--` was written"],
      ["a{color:U002Dx}", "`u002d` stands where `--` was written"],
    ];
    for (const [css, reason] of bad) {
      const index = parse(css.replace("a{", ".a{"));
      expect({ css, reasons: reasons(index).map((r) => r.replace(/^[^:]+: /, "")) }).toEqual({
        css,
        reasons: [reason],
      });
      expect(styleOf(index, "a")).toBeUndefined();
    }
    const fine = [
      ".a{--x: ;--y:}",
      ".a{width:var(--x,)}",
      ".a{width:var(--x, )}",
      ".a{width:env(safe-area-inset-top,)}",
      ".a{background:url()}",
      ".a{background:url( )}",
      ".a{background:url(\"data:image/svg+xml;utf8,<svg a='b,' c='(,)'/>\")}",
      ".a{background:url(data:image/png;base64,AAAA==,)}",
      ".a{clip-path:circle()}",
      ".a{clip-path:ellipse( )}",
      ".a{content:'(,)'}",
      '.a{content:"!important u002d"}',
      ".a{font-family:Arial,sans-serif}",
      ".a{transition:opacity .2s,transform .3s}",
      ".a{width:calc(1px + (2px*3))}",
      ".a{margin:0 !important}",
      ".a{margin:0!important}",
      ".a{grid-template-columns:repeat(2,minmax(0,1fr))}",
      ".a{color:rgb(0 0 0 / 50%)}",
    ];
    for (const css of fine) {
      const index = parse(css);
      expect({ css, artifacts: index.artifacts }).toEqual({ css, artifacts: [] });
      expect(styleOf(index, "a")).toBeDefined();
    }
  });

  test("a custom property may be empty (`--x: ;` is valid CSS and means the empty value)", () => {
    expect(styleOf(parse(".a{--x: ;}"), "a")).toEqual({ "--x": "" });
  });

  test("the prefixed twin of an empty value is reported as well: each declaration is judged", () => {
    const index = parse(".a{-moz-column-gap:  ;column-gap:  ;color:red}");
    expect(styleOf(index, "a")).toEqual({ color: "red" });
    expect(reasons(index)).toEqual([
      "-moz-column-gap: the value is empty",
      "column-gap: the value is empty",
    ]);
  });

  test("real data: fineline's `column-gap:  ;` (17 rules), `background-image: ;` and `minmax(, 1fr)`; ap's `!important` in the middle", () => {
    const post = parse(readFixtureCss("fineline", "cc-post-5278.css"));
    // `.container-c474ea9{row-gap:2rem;-moz-column-gap:  ;column-gap:  ;position:relative;display:flex;}`
    expect(styleOf(post, "container-c474ea9")).toMatchObject({
      rowGap: "2rem",
      position: "relative",
      display: "flex",
    });
    expect(styleOf(post, "container-c474ea9")).not.toHaveProperty("columnGap");
    expect(reasons(post)).toContain("column-gap: the value is empty");
    const home = parse(readFixtureCss("fineline", "cc-post-5246.css"));
    expect(reasons(home)).toContain("background-image: the value is empty");
    expect(styleOf(home, "div-cff67a7")).not.toHaveProperty("backgroundImage");
    const archive = parse(readFixtureCss("fineline", "cc-post-5307.css"));
    expect(reasons(archive)).toContain(
      "grid-template-columns: minmax() starts with an empty argument",
    );
    const main = parse(readFixtureCss("ap", "cc-main.css"));
    expect(reasons(main)).toContain(
      "grid-template-columns: minmax() starts with an empty argument",
    );
  });

  test("across the whole corpus: no value the index keeps is one a browser would discard (judged by the oracle's own scan)", () => {
    let checked = 0;
    for (const { css } of [...REAL, ...OPTION_CSS, ...INLINE_CSS]) {
      for (const style of everyStyle(parsed(css))) {
        walkKeys(style, (key, value) => {
          if (typeof value !== "string") return;
          checked += 1;
          // The scan judges what postcss calls the value: without the `!important` flag the index adds back.
          const bare = value.replace(/\s*!important$/, "");
          expect({
            key,
            value,
            discarded: discardedByBrowsers(key.startsWith("--") ? key : camelToKebab(key), bare),
          }).toEqual({
            key,
            value,
            discarded: false,
          });
        });
      }
    }
    expect(checked).toBeGreaterThan(30_000);
  });

  test("the oracle's scan and the reader agree on every declaration of the corpus, kept or reported", () => {
    for (const { css } of [...REAL, ...OPTION_CSS]) {
      const index = parsed(css);
      let flagged = 0;
      postcss.parse(css).walkDecls((declaration) => {
        const value = declaration.value + (declaration.important ? " !important" : "");
        if (discardedByBrowsers(declaration.prop, declaration.value)) flagged += 1;
        else expect(typeof value).toBe("string");
      });
      const reported = index.artifacts.filter(
        (a) =>
          a.code === CSS_ARTIFACT.invalidValue && !/(undefined|\[object Object\])/.test(a.detail),
      ).length;
      expect(reported).toBe(flagged);
    }
  });
});

// ── Selectors no browser accepts ─────────────────────────────────────────────────────────────────

describe("an empty or malformed class, id or attribute selector is not a place for declarations", () => {
  test('`.` (a block whose classID is empty) is the generator\'s bug, reported like `.undefined`, and keeps no class named ""', () => {
    const index = parse(".{align-items:center;display:flex}.ok{color:red}");
    expect([...index.classes.keys()]).toEqual(["ok"]);
    expect(index.other.size).toBe(0);
    expect(index.artifacts).toEqual([
      {
        code: "css.undefined-selector",
        selector: ".",
        detail: 'selector "." has no class name (a block without a classID)',
      },
    ]);
  });

  test("an empty `.` rule says so, like an empty `.undefined` rule", () => {
    expect(parse(".{}").artifacts.map((a) => a.detail)).toEqual([
      'selector "." has no class name (a block without a classID) and the rule is empty',
    ]);
  });

  test("real data: fineline's cc-post-5272, 5274 and 5276 each have `.{align-items:center;justify-content:center;position:relative;display:flex}`", () => {
    for (const name of ["cc-post-5272.css", "cc-post-5274.css", "cc-post-5276.css"]) {
      const css = readFixtureCss("fineline", name);
      expect(css).toContain(
        ".{align-items:center;justify-content:center;position:relative;display:flex;}",
      );
      const index = parse(css);
      expect(index.classes.has("")).toBe(false);
      expect(index.artifacts.filter((a) => a.selector === ".").length).toBeGreaterThan(0);
    }
    // And through the loader, which is what a block converter looks classes up in.
    const loaded = mergeCssIndexes(parse(readFixtureCss("fineline", "cc-post-5276.css")));
    expect(loaded.classes.get("")).toBeUndefined();
  });

  const nothing: string[] = [
    ".",
    ". svg",
    "a.",
    ".:hover",
    "..a",
    ".a..b",
    "#",
    ".a #",
    ".1a",
    ".-",
    ".-1",
    "#1a",
    ".a:not(.1b)",
    ".a:is(.b, .)",
    "[]",
    ".a[]",
    "%",
    "a %",
  ];
  for (const selector of nothing) {
    test(`classifySelector(${JSON.stringify(selector)}) is null: no browser applies it`, () => {
      expect(classifySelector(selector)).toBeNull();
      const index = parse(`${selector}{color:red}`);
      expect(index.classes.size + index.other.size).toBe(0);
      expect(index.artifacts).toHaveLength(1);
      expect(["css.undefined-selector", "css.unclassified"]).toContain(index.artifacts[0]!.code);
    });
  }

  const fine: [string, string][] = [
    [".--x", "--x"],
    [".-x", "-x"],
    [".x-1", "x-1"],
    [".\\31 23", "123"],
    [".md\\:flex", "md:flex"],
    [".\\-1", "-1"],
    [".é", "é"],
    [".a\\.b", "a.b"],
    [".\\@x", "@x"],
    [".__x", "__x"],
  ];
  for (const [selector, name] of fine) {
    test(`${selector} is the class ${JSON.stringify(name)}`, () => {
      expect(classifySelector(selector)).toEqual({ kind: "class", name, key: "" });
    });
  }

  test("the other message: a selector that is not valid names what is wrong with it", () => {
    const messages = nothing
      .filter((selector) => !selector.includes(".") || selector !== ".")
      .map((selector) => parse(`${selector}{color:red}`).artifacts[0]!.detail);
    expect(messages).toContain('selector ".1a" "1a" is not a valid class name');
    expect(messages).toContain('selector "[]" has an attribute selector with no name');
    expect(messages).toContain('selector "%" "%" is not a valid type selector');
    expect(messages).toContain('selector "#" has an empty id name');
  });

  test("a lone `@` is not a selector at all: the parser takes it for an at-rule without a name", () => {
    expect(classifySelector("@")).toBeNull();
    expect(codesOf(parse("@{color:red}.ok{color:blue}"))).toEqual([CSS_ARTIFACT.syntaxError]);
    expect(styleOf(parse("@{color:red}.ok{color:blue}"), "ok")).toEqual({ color: "blue" });
  });

  test("attribute values and escapes that merely contain a dot are not empty classes", () => {
    expect(classifySelector('.a[href$=".pdf"]')).toEqual({
      kind: "class",
      name: "a",
      key: '[href$=".pdf"]',
    });
    expect(classifySelector('.a[x="b."]')).toEqual({ kind: "class", name: "a", key: '[x="b."]' });
    expect(classifySelector("a.b.c")?.kind).toBe("other");
  });
});

// ── A stylesheet with a syntax error ─────────────────────────────────────────────────────────────

describe("a stylesheet postcss refuses is read rule by rule, the way a browser reads it", () => {
  /** What the module keeps of three rules around one defect: the classes `a`, `b`, `c` that survive, as `{a: color, b: color, c: margin-top}`. */
  function survivors(css: string): { index: CssIndex; kept: Record<string, JxStyle | undefined> } {
    const index = parse(css);
    return {
      index,
      kept: { a: styleOf(index, "a"), b: styleOf(index, "b"), c: styleOf(index, "c") },
    };
  }

  // Each of these was checked in Chrome: `b` and `c` are applied in every one, `a` only where noted.
  const cases: [string, string, { a?: JxStyle; b?: JxStyle; c?: JxStyle }, string][] = [
    [
      "a stray `}` between two rules: the rule that follows it is the casualty, as in a browser",
      ".a{color:red}}.b{color:blue}.c{margin-top:5px}",
      { a: { color: "red" }, c: { marginTop: "5px" } },
      "the rule at line 1 cannot be parsed (Unexpected }) and is skipped",
    ],
    [
      "a stray `}` first",
      "}.b{color:blue}.c{margin-top:5px}",
      { c: { marginTop: "5px" } },
      "the rule at line 1 cannot be parsed (Unexpected }) and is skipped",
    ],
    [
      "a block left open at the end of the file is closed there (the commonest typo)",
      ".b{color:blue}.c{margin-top:5px}.a{color:red",
      { a: { color: "red" }, b: { color: "blue" }, c: { marginTop: "5px" } },
      "the block that opens at line 1 is never closed; it is closed at the end of the stylesheet, as a browser does",
    ],
    [
      "a comment left open at the end: everything after it is comment",
      ".b{color:blue}.c{margin-top:5px}/* oops .a{color:red}",
      { b: { color: "blue" }, c: { marginTop: "5px" } },
      "the comment at line 1 is never closed, so the rest of the stylesheet is comment",
    ],
    [
      "a declaration without a colon costs that declaration only",
      ".b{color:blue}.a{color red;margin-left:1px}.c{margin-top:5px}",
      { a: { marginLeft: "1px" }, b: { color: "blue" }, c: { marginTop: "5px" } },
      'the declaration "color red" at line 1 cannot be parsed (Unknown word color) and is skipped',
    ],
    [
      "a render-time token standing as a value costs that declaration only",
      ".b{color:blue}.a{background-image:{featuredimage};margin-left:1px}.c{margin-top:5px}",
      { a: { marginLeft: "1px" }, b: { color: "blue" }, c: { marginTop: "5px" } },
      'the declaration "background-image:{featuredimage}" at line 1 cannot be parsed (Unknown word featuredimage) and is skipped',
    ],
    [
      "a render-time token standing as a selector",
      ".b{color:blue}.{class}{color:red}.c{margin-top:5px}",
      { b: { color: "blue" }, c: { marginTop: "5px" } },
      'the declaration "class" at line 1 cannot be parsed (Unknown word class) and is skipped',
    ],
    [
      "a missing semicolon runs two declarations together, which is one invalid declaration",
      ".b{color:blue}.a{color:red margin:0;padding:1px}.c{margin-top:5px}",
      { a: { padding: "1px" }, b: { color: "blue" }, c: { marginTop: "5px" } },
      'the declaration "color:red margin:0" at line 1 cannot be parsed (Missed semicolon) and is skipped',
    ],
    [
      // The string runs to the end of its line and swallows the `}` that would have closed `.a`, so
      // `.c` is written inside a block that never ends: in a browser it is `.a .c`, and does nothing.
      "an unterminated string ends at the end of its line, and takes the rule that was waiting for its `}` with it",
      '.b{color:blue}\n.a{content:"abc;margin-left:1px}\n.c{margin-top:5px}',
      { b: { color: "blue" } },
      "the rule at line 2 cannot be parsed (Unclosed string) and is skipped",
    ],
    [
      "a parenthesis that never closes swallows the rest of the file",
      ".b{color:blue}.a{color:rgb(1,2,3}.c{margin-top:5px}",
      { b: { color: "blue" } },
      "the rule at line 1 is cut off by a parenthesis that is never closed and is skipped",
    ],
    [
      "a block left open inside a `@media` rule at the end of the file",
      ".b{color:blue}@media (max-width:2000px){.c{margin-top:5px}",
      { b: { color: "blue" }, c: { "@(max-width: 2000px)": { marginTop: "5px" } } },
      "the block that opens at line 1 is never closed; it is closed at the end of the stylesheet, as a browser does",
    ],
    [
      "a stray `}` that ends a `@media` rule early costs the rule that follows",
      ".b{color:blue}.a{color:red;}}@media (max-width:2000px){.c{margin-top:5px}}",
      { a: { color: "red" }, b: { color: "blue" } },
      "the rule at line 1 cannot be parsed (Unexpected }) and is skipped",
    ],
  ];
  for (const [title, css, expected, message] of cases) {
    test(title, () => {
      const { index, kept } = survivors(css);
      expect(kept).toEqual({ a: undefined, b: undefined, c: undefined, ...expected });
      expect(index.artifacts.map((artifact) => artifact.detail)).toContain(message);
      expect(
        index.artifacts.every((artifact) =>
          [
            "css.syntax-error",
            "css.media-unmapped",
            "css.undefined-selector",
            "css.unclassified",
          ].includes(artifact.code),
        ),
      ).toBe(true);
    });
  }

  test("a comment left open after a complete rule is the only thing reported: the rule before it is not damaged", () => {
    const index = parse(".c{margin-top:5px}/* oops");
    expect(index.artifacts.map((artifact) => artifact.detail)).toEqual([
      "the comment at line 1 is never closed, so the rest of the stylesheet is comment",
    ]);
    expect(styleOf(index, "c")).toEqual({ marginTop: "5px" });
  });

  test("a comment left open inside the last block is closed with it: the block is kept, and both are reported", () => {
    const index = parse(".a{color:red /* oops }");
    expect(styleOf(index, "a")).toEqual({ color: "red" });
    expect(index.artifacts.map((artifact) => artifact.detail)).toEqual([
      "the block that opens at line 1 is never closed; it is closed at the end of the stylesheet, as a browser does",
      "the comment at line 1 is never closed, so the rest of the stylesheet is comment",
    ]);
  });

  test("an `@import` that follows a defect is still found (statement at-rules end at their `;`)", () => {
    // The stray `}` is part of the prelude of `.y`, which is the casualty; the statement after it is not.
    const index = parse(
      '.x{margin:0}}.y{margin:1px}@import url("a.css");.a{color:red}@import url("b.css");',
    );
    expect(index.atRules.map((rule) => rule.key)).toEqual([
      '@import url("a.css")',
      '@import url("b.css")',
    ]);
    expect(styleOf(index, "a")).toEqual({ color: "red" });
    expect(styleOf(index, "x")).toEqual({ margin: "0" });
    expect(styleOf(index, "y")).toBeUndefined();
  });

  test("an unquoted `url(…)` is one token to its `)`: quotes, braces and semicolons inside it do not end anything", () => {
    // A browser reads `url(a'b.png)` as a bad URL token, not as the start of a string, so what
    // follows it is still rules. The stray `}` is the defect that sends the file down this path.
    const index = parse(
      ".x{background:url(a'b.png)}.y{color:red}.w{background:url(data:image/svg+xml;utf8,<svg a='1'>{;})}.v{margin:1px}}.z{margin:0}",
    );
    expect([...index.classes.keys()]).toEqual(["x", "y", "w", "v"]);
    expect(styleOf(index, "y")).toEqual({ color: "red" });
    expect(styleOf(index, "v")).toEqual({ margin: "1px" });
    expect(index.artifacts.map((artifact) => artifact.detail)).toEqual([
      "the rule at line 1 cannot be parsed (Unexpected }) and is skipped",
    ]);
  });

  test("a `@media` block keeps the rules in it that are sound", () => {
    const index = parse(
      "@media screen and (max-width: 992px){.a{color:red}.b{color red}.c{color:blue}}.d{margin:0}",
    );
    expect(styleOf(index, "a")).toEqual({ "@--md": { color: "red" } });
    expect(styleOf(index, "c")).toEqual({ "@--md": { color: "blue" } });
    expect(styleOf(index, "d")).toEqual({ margin: "0" });
    expect(index.artifacts.map((artifact) => artifact.detail)).toEqual([
      'the declaration "color red" at line 1 cannot be parsed (Unknown word color) and is skipped',
    ]);
  });

  test("the line of each loss is the line it is on", () => {
    const index = parse(
      ".a{color:red}\n\n.b{\n  color red;\n  margin:0\n}\n}.c{color:blue}\n.d{margin:0}",
    );
    expect(index.artifacts.map((artifact) => artifact.detail)).toEqual([
      'the declaration "color red" at line 4 cannot be parsed (Unknown word color) and is skipped',
      "the rule at line 7 cannot be parsed (Unexpected }) and is skipped",
    ]);
    expect(styleOf(index, "b")).toEqual({ margin: "0" });
    expect(styleOf(index, "d")).toEqual({ margin: "0" });
  });

  test("`file` is named in each loss", () => {
    const index = parseCwiclyCss(".a{color:red}}.b{}", BPS, { file: "cc-post-9.css" });
    expect(index.artifacts.length).toBeGreaterThan(0);
    for (const artifact of index.artifacts) expect(artifact.detail).toEndWith("(in cc-post-9.css)");
  });

  test("real data: ap's cc-global-classes.css with a stray `}` appended keeps every class, and says what it lost", () => {
    const css = readFixtureCss("ap", "cc-global-classes.css");
    const intact = parse(css);
    const damaged = parse(`${css}}`);
    expect(damaged.classes.size).toBe(intact.classes.size);
    expect(damaged.classes.size).toBeGreaterThan(40);
    expect(Object.fromEntries(damaged.classes)).toEqual(Object.fromEntries(intact.classes));
    // The stylesheet's own artifacts are unchanged; the stray brace adds one.
    expect(damaged.artifacts.filter((a) => a.code !== CSS_ARTIFACT.syntaxError)).toEqual(
      intact.artifacts,
    );
    expect(damaged.artifacts.filter((a) => a.code === CSS_ARTIFACT.syntaxError)).toHaveLength(1);
  });

  test("real data: the same file missing its last `}` (the commonest typo) is the same index plus a note", () => {
    const css = readFixtureCss("ap", "cc-global-classes.css");
    expect(css.trimEnd().endsWith("}")).toBe(true);
    const intact = parse(css);
    const truncated = parse(css.trimEnd().slice(0, -1));
    expect(Object.fromEntries(truncated.classes)).toEqual(Object.fromEntries(intact.classes));
    expect(Object.fromEntries(truncated.other)).toEqual(Object.fromEntries(intact.other));
    expect(truncated.artifacts.filter((a) => a.code !== CSS_ARTIFACT.syntaxError)).toEqual(
      intact.artifacts,
    );
    expect(
      truncated.artifacts.filter((a) => a.code === CSS_ARTIFACT.syntaxError).map((a) => a.detail),
    ).toEqual([
      expect.stringContaining("is never closed; it is closed at the end of the stylesheet"),
    ]);
  });

  test("real data: a rule cut in half in the middle of fineline's cc-global-classes.css loses that rule and nothing else", () => {
    const css = readFixtureCss("fineline", "cc-global-classes.css");
    const at = css.indexOf(".paragraph-bold{");
    expect(at).toBeGreaterThan(0);
    const damaged =
      css.slice(0, at) + ".paragraph-bold{font-weight" + "}" + css.slice(css.indexOf("}", at) + 1);
    const intact = parse(css);
    const index = parse(damaged);
    expect(index.classes.has("paragraph-bold")).toBe(false);
    expect([...index.classes.keys()]).toEqual(
      [...intact.classes.keys()].filter((name) => name !== "paragraph-bold"),
    );
    expect(index.artifacts.some((a) => a.code === CSS_ARTIFACT.syntaxError)).toBe(true);
  });

  test("it is deterministic and total: no input makes it throw (a fuzz over fragments of real CSS)", () => {
    const real = readFixtureCss("fineline", "cc-post-5297.css");
    let seed = 7;
    const next = (n: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const alphabet = [
      "{",
      "}",
      "(",
      ")",
      "[",
      "]",
      '"',
      "'",
      "/*",
      "*/",
      ";",
      ":",
      "@media",
      "\\",
      "\n",
      "url(",
      "!important",
    ];
    for (let round = 0; round < 300; round += 1) {
      let css = real.slice(next(2000), 2000 + next(2000));
      for (let k = next(6); k > 0; k -= 1) {
        const at = next(css.length + 1);
        css = css.slice(0, at) + alphabet[next(alphabet.length)]! + css.slice(at);
      }
      expect(() => parse(css), css.slice(0, 80)).not.toThrow();
      const again = parse(css);
      expect(JSON.stringify([...again.classes])).toBe(JSON.stringify([...parse(css).classes]));
    }
  });
});

describe("a stylesheet nested absurdly deep", () => {
  const nested = (
    depth: number,
    open = "@supports (display:grid){",
    inner = ".a{color:red}",
  ): string => `${open.repeat(depth)}${inner}${"}".repeat(depth)}`;

  test("never throws, whatever the depth: 20,000 levels is one artifact and nothing else lost", () => {
    const index = parse(`${nested(20_000)}.b{color:blue}`);
    expect(index.classes.has("a")).toBe(false);
    expect(styleOf(index, "b")).toEqual({ color: "blue" });
    expect(index.artifacts.map((a) => a.detail)).toEqual([
      "the rule at line 1 nests blocks more than 64 deep and is skipped",
    ]);
  });

  test("64 blocks deep is read, 65 is not (the rule's own block counts)", () => {
    expect(styleOf(parse(nested(63)), "a")).toBeDefined();
    expect(parse(nested(63)).artifacts).toEqual([]);
    expect(styleOf(parse(nested(64)), "a")).toBeUndefined();
    expect(codesOf(parse(nested(64)))).toEqual([CSS_ARTIFACT.syntaxError]);
  });

  test("deep native nesting (`.n{.n{.n{…}}}`) is bounded too, in time as well as in stack", () => {
    const started = performance.now();
    const index = parse(nested(5000, ".n{", "color:red"));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(index.artifacts.map((a) => a.code)).toEqual([CSS_ARTIFACT.syntaxError]);
    const shallow = parse(nested(40, ".n{", "color:red"));
    expect(shallow.artifacts).toEqual([]);
    expect(shallow.classes.size + shallow.other.size).toBeGreaterThan(0);
  });

  test("the rules around a too-deep rule are kept, and everything the real corpus nests (at most 6 levels) is read", () => {
    const index = parse(`.x{margin:0}${nested(100)}.y{margin:1px}`);
    expect(styleOf(index, "x")).toEqual({ margin: "0" });
    expect(styleOf(index, "y")).toEqual({ margin: "1px" });
    expect(index.artifacts).toHaveLength(1);
  });

  test("a rule with tens of thousands of vendor-prefixed values is not quadratic", () => {
    const body = Array.from(
      { length: 30_000 },
      (_, i) => `width:-webkit-fit-content;-webkit-x${i}:1`,
    ).join(";");
    const started = performance.now();
    const index = parse(`.a{${body};width:fit-content}`);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(styleOf(index, "a")!["width"]).toBe("fit-content");
  });

  test("a value nested tens of thousands of functions deep costs that declaration, not the stylesheet", () => {
    const deep = `.c{margin:0}.a{width:${"f(".repeat(40_000)}1${")".repeat(40_000)};color:red}.d{margin:1px}`;
    const index = parse(deep);
    expect([...index.classes.keys()]).toEqual(["c", "a", "d"]);
    expect(styleOf(index, "c")).toEqual({ margin: "0" });
    expect(styleOf(index, "a")).toEqual({ color: "red" });
    expect(styleOf(index, "d")).toEqual({ margin: "1px" });
    expect(index.artifacts).toHaveLength(1);
    expect(index.artifacts[0]!.detail).toEndWith("(the value is nested too deeply to read)");
    // And what the report quotes of it is cut to a readable length.
    expect(index.artifacts[0]!.detail.length).toBeLessThan(400);
  });

  test("a selector that is huge is quoted in a report at a readable length, in the detail and the selector field alike", () => {
    const selector = `.a${":is(".repeat(5000)}.b${")".repeat(5000)}`;
    const index = parse(`${selector}{color:red}`);
    expect(index.artifacts).toHaveLength(1);
    expect(index.artifacts[0]!.detail.length).toBeLessThan(400);
    expect(index.artifacts[0]!.selector!.length).toBeLessThan(400);
    expect(index.artifacts[0]!.selector).toEndWith("…");
  });
});

// ── The palette ──────────────────────────────────────────────────────────────────────────────────

describe("palette references the generator left unresolved (`!var=<id>!`)", () => {
  /** The `colors` of ap's `cwicly_global_styles` option, in the shape `CwiclyOptions.globalStyles.colors` has. */
  const apPalette = (() => {
    const styles = JSON.parse(fixtureOptionCss("ap", "cwicly_global_styles")!) as {
      activeStyle: string;
      styles: Record<
        string,
        { colors: { id: string; name: string; color: string; variable: string }[] }
      >;
    };
    return styles.styles[styles.activeStyle]!.colors.map(({ id, name, color, variable }) => ({
      id,
      name,
      value: color,
      variable,
    }));
  })();

  test('ap\'s palette has the colour the stylesheet names: 9d4k1 is White, cc-color-5 (so it did not "no longer exist")', () => {
    const white = apPalette.find((colour) => colour.id === "9d4k1");
    expect(white).toMatchObject({ name: "White", variable: "cc-color-5" });
  });

  test("without a palette the module says only what it knows: the generator left it unresolved", () => {
    const index = parse(readFixtureCss("ap", "cc-global-classes.css"));
    const [artifact] = index.artifacts.filter((a) => a.code === CSS_ARTIFACT.unresolvedPaletteVar);
    expect(artifact!.detail).toBe(
      'fill: the generator left the palette reference "9d4k1" unresolved',
    );
    expect(artifact!.detail).not.toContain("no longer exists");
  });

  test("with the palette, the reference becomes the colour's custom property, !important kept, and nothing is reported", () => {
    const css = readFixtureCss("ap", "cc-global-classes.css");
    const index = parseCwiclyCss(css, BPS, { palette: apPalette });
    expect(index.artifacts.filter((a) => a.code === CSS_ARTIFACT.unresolvedPaletteVar)).toEqual([]);
    // `.searchform:hover .cc-icn svg path{fill:!var=9d4k1! !important}`, next to its sibling's
    // `.searchform-light:hover .cc-icn svg path{fill:var(--cc-color-5) !important}`.
    expect(styleOf(index, "searchform")?.["&:hover .cc-icn svg path"]).toEqual({
      fill: "var(--cc-color-5) !important",
    });
    expect(styleOf(index, "searchform-light")?.["&:hover .cc-icn svg path"]).toEqual({
      fill: "var(--cc-color-5) !important",
    });
    // The rest of the class is as it was.
    const without = parse(css);
    expect(styleOf(index, "searchform")).toEqual({
      ...styleOf(without, "searchform"),
      "&:hover .cc-icn svg path": { fill: "var(--cc-color-5) !important" },
    });
  });

  test("with the palette, an id that is not in it is reported as unknown (and that is the case where the colour is gone)", () => {
    const index = parseCwiclyCss(".a{color:!var=evfyw!;fill:!var=9d4k1!}", BPS, {
      palette: apPalette,
    });
    expect(styleOf(index, "a")).toEqual({ fill: "var(--cc-color-5)" });
    expect(index.artifacts).toEqual([
      {
        code: "css.unresolved-palette-var",
        selector: ".a",
        detail: 'color: no colour with the id "evfyw" exists in the palette',
      },
    ]);
  });

  test("the custom property may be written with or without its dashes, and a colour may be referenced twice in a value", () => {
    const index = parseCwiclyCss(
      ".a{background:linear-gradient(!var=x1!,!var=x2!);color:!var=x1!}",
      BPS,
      {
        palette: [
          { id: "x1", variable: "cc-color-1" },
          { id: "x2", variable: "--color-kbvn1" },
        ],
      },
    );
    expect(styleOf(index, "a")).toEqual({
      background: "linear-gradient(var(--cc-color-1),var(--color-kbvn1))",
      color: "var(--cc-color-1)",
    });
    expect(index.artifacts).toEqual([]);
  });

  test("some references resolve and some do not, in one value: the declaration is dropped and the unknown id named", () => {
    const index = parseCwiclyCss(".a{background:linear-gradient(!var=x1!,!var=zz!)}", BPS, {
      palette: [{ id: "x1", variable: "cc-color-1" }],
    });
    expect(styleOf(index, "a")).toBeUndefined();
    expect(index.artifacts.map((a) => a.detail)).toEqual([
      'background: no colour with the id "zz" exists in the palette',
    ]);
  });

  test("an empty palette is a palette: every reference is unknown, which is a different thing to say than 'unresolved'", () => {
    const index = parseCwiclyCss(".a{color:!var=x1!}", BPS, { palette: [] });
    expect(index.artifacts.map((a) => a.detail)).toEqual([
      'color: no colour with the id "x1" exists in the palette',
    ]);
  });

  test("a palette reference is resolved in a rule's @media block, a nested rule and an at-rule body alike", () => {
    const palette = [{ id: "x1", variable: "cc-color-1" }];
    const index = parseCwiclyCss(
      "@media screen and (max-width: 992px){.a:hover{color:!var=x1!}}.b{.c{color:!var=x1!}}@font-face{font-family:x;color:!var=x1!}",
      BPS,
      { palette },
    );
    expect(styleOf(index, "a")).toEqual({ "@--md": { ":hover": { color: "var(--cc-color-1)" } } });
    expect(styleOf(index, "b")).toEqual({ "& .c": { color: "var(--cc-color-1)" } });
    expect(index.atRules[0]!.style).toEqual({ fontFamily: "x", color: "var(--cc-color-1)" });
    expect(index.artifacts).toEqual([]);
  });

  test("loadCssIndex takes the palette too, and passes it to every file", async () => {
    const source = memorySource({ "a.css": ".a{color:!var=x1!}", "b.css": ".b{color:!var=x1!}" });
    const index = await loadCssIndex(source, ["a.css", "b.css"], BPS, {
      palette: [{ id: "x1", variable: "cc-color-1" }],
    });
    expect(styleOf(index, "a")).toEqual({ color: "var(--cc-color-1)" });
    expect(styleOf(index, "b")).toEqual({ color: "var(--cc-color-1)" });
    expect(index.artifacts).toEqual([]);
    const bare = await loadCssIndex(source, ["a.css"], BPS);
    expect(bare.artifacts.map((a) => a.detail)).toEqual([
      'color: the generator left the palette reference "x1" unresolved (in a.css)',
    ]);
  });

  test("a palette that is not given costs nothing: a stylesheet with no references behaves the same either way", () => {
    const css = readFixtureCss("fineline", "cc-global-classes.css");
    expect(Object.fromEntries(parseCwiclyCss(css, BPS, { palette: [] }).classes)).toEqual(
      Object.fromEntries(parse(css).classes),
    );
  });
});

// ── Mutants the first reviewers found alive ──────────────────────────────────────────────────────

describe("behaviour that no test used to pin", () => {
  test("a nested `+` and `~` selector is a relative selector under the class", () => {
    const index = parse(".p{ + .q{color:red} ~ .r{color:blue} }");
    expect(styleOf(index, "p")).toEqual({
      "& + .q": { color: "red" },
      "& ~ .r": { color: "blue" },
    });
    expect(cssRules(index).map((part) => part.selector)).toEqual([".p + .q", ".p ~ .r"]);
  });

  test("an `@import` inside a rule is not an at-rule of the index: it is reported, and the rule keeps its declarations", () => {
    const index = parse('.p{@import url("a.css");color:red}');
    expect(index.atRules).toEqual([]);
    expect(styleOf(index, "p")).toEqual({ color: "red" });
    expect(index.artifacts).toEqual([
      {
        code: "css.unclassified",
        selector: '@import url("a.css")',
        detail: 'at-rule "@import url("a.css")" inside a rule has no Jx equivalent',
      },
    ]);
  });

  test("an `@import` nested in a conditional at-rule is not an `@import` of the index either", () => {
    const index = parse('@media print{@import url("a.css");}');
    expect(index.atRules).toEqual([]);
    expect(index.artifacts.map((a) => a.code)).toEqual([
      CSS_ARTIFACT.mediaUnmapped,
      CSS_ARTIFACT.unclassified,
    ]);
  });

  test("a vendor twin is collapsed whatever the case it is written in", () => {
    const index = parse(
      ".a{-WEBKIT-Column-Gap:1rem;COLUMN-GAP:2rem;-Moz-Appearance:none;Appearance:none}",
    );
    expect(styleOf(index, "a")).toEqual({ columnGap: "2rem", appearance: "none" });
  });

  test("`!important` is recognised whatever its case, and a vendor value is judged in lower case too", () => {
    const index = parse(
      ".a{width:-WEBKIT-fit-content;width:fit-content;color:red!IMPORTANT}.a{color:blue}",
    );
    expect(styleOf(index, "a")).toEqual({ width: "fit-content", color: "red !important" });
  });

  test("a rule whose declarations all turn out to be artifacts leaves nothing behind, not an empty class", () => {
    const index = parse(".a{width:[object Object]px}.b{color:red}");
    expect([...index.classes.keys()]).toEqual(["b"]);
  });
});

describe("a seeded fuzz: small random stylesheets, every combination of classes on an element", () => {
  // The same vocabulary a differential fuzz in real Chrome was run over (about 1,000 stylesheets, no
  // difference between the original and the layout, and a class-by-class emission wrong in about 45%):
  // classes, tags, :hover, descendants, pseudo-elements, breakpoint blocks, shorthands, !important.
  const PROPERTIES: [string, string[]][] = [
    ["color", ["red", "blue", "green"]],
    ["padding", ["1px", "2px 3px"]],
    ["padding-top", ["4px", "5px"]],
    ["margin", ["1px", "2px"]],
    ["margin-left", ["3px", "6px"]],
    ["display", ["block", "flex", "none"]],
    ["line-height", ["20px", "30px"]],
    ["font", ["12px Arial", "14px serif"]],
    ["font-size", ["10px", "20px"]],
    ["row-gap", ["1px", "7px"]],
    ["gap", ["2px", "8px"]],
    ["border", ["1px solid red", "2px dotted blue"]],
    ["border-top-color", ["green"]],
  ];
  const SELECTORS = [
    ".a",
    ".b",
    ".c",
    ".a.b",
    "div.a",
    "span.b",
    ".a:hover",
    ".b:hover",
    ".a span",
    ".b span",
    ".a > span",
    ".a::before",
    ".b::before",
    ".c:hover span",
    ".a.c",
    ".a:not(.b)",
    ":is(.a,.b)",
    ":where(.c)",
    ".a,.b",
    "div",
  ];
  const CONTEXTS = [
    "",
    "",
    "@media screen and (max-width: 992px)",
    "@media screen and (max-width: 576px)",
    "@supports (display:grid)",
    "@media screen and (max-width: 992px){@supports (display:grid)",
  ];

  function random(seed: number): <T>(items: readonly T[]) => T {
    let state = seed;
    return (items) => {
      state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return items[Math.floor((state / 4_294_967_296) * items.length)]!;
    };
  }

  function stylesheet(pick: ReturnType<typeof random>): string {
    const rules: string[] = [];
    for (let i = 0, n = 5 + pick([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]); i < n; i += 1) {
      const selector = pick(SELECTORS);
      const context = pick(CONTEXTS);
      const declarations = Array.from({ length: pick([1, 2, 3]) }, () => {
        const [property, values] = pick(PROPERTIES);
        return `${property}:${pick(values)}${pick([0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) === 1 ? " !important" : ""}`;
      }).join(";");
      const body = `${selector}{${declarations}${selector.includes("::before") ? ";content:'x'" : ""}}`;
      const opens = (context.match(/\{/g) ?? []).length;
      rules.push(context === "" ? body : `${context}{${body}}${"}".repeat(opens)}`);
    }
    return rules.join("\n");
  }

  const subjects: Subject[] = [];
  for (const mask of [1, 2, 3, 4, 5, 6, 7]) {
    const classes = ["a", "b", "c"].filter((_, i) => (mask & (1 << i)) !== 0);
    for (const tag of ["div", "span"]) subjects.push({ classes, tag });
  }

  test("300 stylesheets: projectStyles is the original cascade for every one", () => {
    const pick = random(20_240_917);
    let treeWrong = 0;
    let severalSheets = 0;
    for (let round = 0; round < 300; round += 1) {
      const css = stylesheet(pick);
      const index = parse(css);
      if (projectStyles(index, BPS).length > 1) severalSheets += 1;
      const differences = cascadeDifferences(
        css,
        renderCascade(index, BPS),
        subjects,
        [1000, 700, 400],
      );
      expect({ css, differences: differences.slice(0, 3) }).toEqual({ css, differences: [] });
      if (
        cascadeDifferences(css, renderCssIndex(index, BPS), subjects, [1000, 700, 400]).length > 0
      ) {
        treeWrong += 1;
      }
    }
    // The control: class-by-class emission of the same indexes is wrong for a good part of them, so a
    // layout that merely reproduced it would have failed above. And the stylesheets are dense enough
    // for the layout to need more than one object in most.
    expect(treeWrong).toBeGreaterThan(60);
    expect(severalSheets).toBeGreaterThan(150);
  });
});
