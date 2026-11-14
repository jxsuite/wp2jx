/**
 * The named formulas (`src/formulas.ts`): that a call means exactly what the expression it replaced
 * meant, for every kind of value an entry holds and on the real dates of the fixtures, that the
 * definition `project.json` carries says the same as the JavaScript a call is written out as, and
 * that a call is written the way the build and Jx Studio read it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { evaluateExpression } from "@jxsuite/runtime/expression";
import {
  ALL_FORMULAS,
  FORMULAS,
  FORMULA_JS,
  INTL_FORMATS,
  formulaCall,
  formulaFunctions,
  formulaJs,
  formulaState,
  formulasUsed,
  intlDateOptions,
  isPath,
  isPipe,
  jsonArg,
  lowerFormulas,
  lowerFormulasIn,
  notOf,
  orFallback,
  pipeOf,
  tagString,
  type FormulaName,
} from "../src/formulas.ts";
import { htmlEscapeExpr } from "../src/jx-util.ts";
import {
  dateExpr,
  dateTag,
  formatDate,
  jsString,
  notEmptyExpr,
  orElse,
  phpEmpty,
  postData,
} from "../src/cwicly/tokens.ts";
import { jxComponentFormulas, jxFormulas, settleFormulas } from "../src/emit/project.ts";
import type { ConvertCtx } from "../src/types.ts";
import { loadSite, makeCtx } from "./helpers/ctx.ts";
import { withFormulas } from "./helpers/formulas.ts";

/** A formula's definition run by Jx's own interpreter, as the build and the browser run it. */
function interpreted(name: FormulaName, ...values: unknown[]): unknown {
  const entry = FORMULAS[name];
  const args = Object.fromEntries(
    entry.parameters.map((p, i) => [(p as { name: string }).name, values[i]]),
  );
  return evaluateExpression(
    entry.$expression as Parameters<typeof evaluateExpression>[0],
    {},
    null,
    { args } as NonNullable<Parameters<typeof evaluateExpression>[3]>,
  );
}

/**
 * The same with a `window`, which is where the interpreter looks a global function up
 * (`Array.isArray`): a browser has one and a build has none.
 */
function inBrowser<T>(run: () => T): T {
  const scope = globalThis as { window?: unknown };
  const had = "window" in scope;
  const before = scope.window;
  scope.window = globalThis;
  try {
    return run();
  } finally {
    if (had) scope.window = before;
    else delete scope.window;
  }
}

const js = formulaFunctions();

/** The two line separators, which end a line of JavaScript source wherever they stand. */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

/** Every kind of value a field of an entry can hold, and a few it should not. */
const VALUES: unknown[] = [
  undefined,
  null,
  "",
  "0",
  "00",
  "0.0",
  " 0",
  " ",
  "a",
  "Tom & <Jerry> \"q\" 'x'",
  "&amp; &lt;",
  0,
  -0,
  1,
  42,
  3.5,
  Number.NaN,
  false,
  true,
  [],
  ["a"],
  ["a", "b"],
  [1, 2],
  {},
  { src: "/a.jpg" },
  { length: 0 },
];

/** A list whose one element is zero: the only values on which a formula and the expression it replaced part. */
const ZERO_LISTS: unknown[] = [[0], ["0"], [[0]]];

const show = (v: unknown): string =>
  v === undefined || Number.isNaN(v) || Object.is(v, -0)
    ? Object.is(v, -0)
      ? "-0"
      : String(v)
    : (JSON.stringify(v) ?? String(v));

describe("a path, and a value read through a formula", () => {
  test("a path starts at a root a template has and reads members, nothing else", () => {
    for (const path of [
      "state",
      "state.entry.data.title",
      "$map.item.data.date",
      "$map.index",
      "item.name",
      "index",
      "$page.locale",
      "$site.name",
      "state.entry.data.featuredImage?.src",
      "state.entry.data['my-field']",
      'state.entry.data.terms?.["post_tag"]',
      "state.rows[0].name",
    ]) {
      expect([path, isPath(path)]).toEqual([path, true]);
    }
    for (const not of [
      "",
      "entry.data.title",
      "$i0.data.title",
      "state.entry.data.title ?? ''",
      "(state.entry.data.title)",
      "state.a + state.b",
      "state.list.map(x => x)",
      "state.f(state.a)",
      "state.entry.data[state.key]",
      "!state.a",
      "state.a ? 1 : 2",
      "Date.now()",
    ]) {
      expect([not, isPath(not)]).toEqual([not, false]);
    }
  });

  test("a pipe is a path or one of the converter's formulas on a pipe; `path ?? ''` gives its path", () => {
    const date = formulaCall("formatDate", "state.entry.data.date", { timeZone: "UTC" });
    expect(isPipe("state.entry.data.x")).toBe(true);
    expect(isPipe(date)).toBe(true);
    expect(isPipe(formulaCall("escapeHtml", formulaCall("orBlank", "$map.item.data.x")))).toBe(
      true,
    );
    expect(isPipe("state.other(state.entry.data.x)")).toBe(false);
    expect(isPipe(`${date}.length`)).toBe(false);
    expect(isPipe("state.escapeHtml(state.a ?? '')")).toBe(false);
    expect(isPipe("state.escapeHtml(state.a + state.b)")).toBe(false);
    expect(pipeOf("state.entry.data.x ?? ''")).toBe("state.entry.data.x");
    expect(pipeOf("state.entry.data.x")).toBe("state.entry.data.x");
    expect(pipeOf("state.a ? '1' : ''")).toBeUndefined();
    expect(pipeOf("(state.a) ?? ''")).toBeUndefined();
  });
});

/** Jx's structured dynamic tag (`@jxsuite/schema/dynamic-tag`), where the installed Jx has one. */
const TAG = await import("@jxsuite/schema/dynamic-tag").catch(() => undefined);

describe.skipIf(TAG === undefined)(
  "what the converter writes, as Jx's dynamic tag reads it",
  () => {
    const tag = TAG as NonNullable<typeof TAG>;
    /** The tag read from `expr`, and that printing it gives `expr` back byte for byte. */
    const read = (expr: string) => {
      const parsed = tag.parseDynamicTag(expr);
      expect([expr, parsed === null ? null : tag.printDynamicTag(parsed)]).toEqual([expr, expr]);
      return parsed as NonNullable<typeof parsed>;
    };
    const TEXTS = [
      "",
      "none",
      'It\'s "quoted"',
      "a \\ b",
      "line\nbreak\r",
      "tab\there",
      `brace {x} $y \`z\` ${LS}${PS}`,
      "café 🎉",
      String.fromCharCode(1),
    ];

    test("a formula call, nested or with JSON arguments, is a tag that prints back as written", () => {
      const date = formulaCall("formatDate", "$map.item.data.date", {
        year: "numeric",
        label: "{a} $b `c`",
      });
      const parsed = read(date);
      expect(parsed.pipe).toMatchObject({ type: "call", name: "formatDate" });
      read(formulaCall("escapeHtml", formulaCall("orBlank", "state.entry.data['a b']")));
      read(`!${formulaCall("notEmpty", "state.entry.data.about")}`);
    });

    test("a fallback is a single-quoted literal of the text, as Studio writes one, and reads back as that text", () => {
      for (const text of TEXTS) {
        const expr = orFallback("state.entry.data.x", jsString(text));
        expect(expr).toBe(`state.entry.data.x || ${tagString(text)}`);
        const parsed = read(expr);
        expect([text, parsed.fallback?.operator, parsed.fallback?.value.value]).toEqual([
          text,
          "||",
          text,
        ]);
        // The same text the converter's own string literal spells, but for a control character,
        // which no JSON string holds raw.
        if (![...text].some((c) => c < " " && c !== "\n" && c !== "\r")) {
          expect(tagString(text)).toBe(jsString(text));
        }
        // And the same value to JavaScript, which is what the build evaluates.
        expect(new Function(`return ${tagString(text)};`)()).toBe(text);
      }
      expect(tagString("tab\there")).toBe("'tab\\there'");
      expect(read(orFallback("state.a ?? ''", "false")).fallback?.value.value).toBe(false);
      read(orFallback(formulaCall("orBlank", "state.entry.data.cta"), jsString("Read more")));
    });

    test("a fallback that is not one literal is kept as given, and is a custom expression", () => {
      // `a || b || c || ''`: the grammar takes one fallback, and the meaning is the chain's.
      const chain = orFallback("state.term.data.seo?.title", "state.term.data.title || ''");
      expect(chain).toBe("state.term.data.seo?.title || state.term.data.title || ''");
      expect(tag.parseDynamicTag(chain)).toBeNull();
      // A string literal with an escape JSON has no spelling for is not respelled.
      expect(orFallback("state.a", "'\\x41'")).toBe("state.a || '\\x41'");
      expect(orFallback("state.a", "'a' + 'b'")).toBe("state.a || 'a' + 'b'");
    });

    test("a negation is `!` on the pipe, which reads as 'is empty'", () => {
      expect(read(notOf("state.entry.data.x ?? ''")).negations).toBe(1);
      expect(read(notOf(formulaCall("notEmpty", "$map.item.data.premium"))).negations).toBe(1);
      expect(tag.parseDynamicTag(notOf("state.a ? 1 : 2"))).toBeNull();
    });
  },
);

describe("a call as it is written", () => {
  test("is `state.<name>(<path>, <JSON>)`, the form Jx Studio prints", () => {
    expect(
      formulaCall("formatDate", "$map.item.data.date", {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "America/New_York",
      }),
    ).toBe(
      'state.formatDate($map.item.data.date, {"year":"numeric","month":"long","day":"numeric","timeZone":"America/New_York"})',
    );
    expect(formulaCall("notEmpty", "state.entry.data.about")).toBe(
      "state.notEmpty(state.entry.data.about)",
    );
  });

  test("an argument is JSON whose strings hold no bare brace, dollar, backtick or line separator (rule 13)", () => {
    const value = { a: "x{y}z", b: ["${danger}", "`tick`", `line${LS}sep${PS}`], "k{": 1 };
    const text = jsonArg(value);
    expect(JSON.parse(text)).toEqual(value);
    // JSON is JavaScript: the build reads the same value.
    expect(new Function(`return (${text});`)()).toEqual(value);
    // What is left of the braces is the structure, which balances.
    let depth = 0;
    for (const c of text) {
      if (c === "{") depth++;
      if (c === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    for (const c of ["$", "`", LS, PS]) expect(text).not.toContain(c);
    expect(text.match(/[{}]/g)).toEqual(["{", "}"]);
    // In a template literal, as the build evaluates a string with a binding.
    const call = formulaCall("escapeHtml", "state.x", value);
    const seen: unknown[] = [];
    const state = { x: "v", escapeHtml: (...args: unknown[]) => (seen.push(args), "ok") };
    expect(new Function("state", `return \`a \${${call}} b\`;`)(state)).toBe("a ok b");
    expect(seen).toEqual([["v", value]]);
  });

  test("the registrar: the formulas the documents call, once each, in a fixed order, and none for none", () => {
    const texts = [
      '{"textContent":"${state.orBlank(state.entry.data.a) || \'x\'}"}',
      '{"children":["${(state.posts ?? []).map(($i0, $x0) => ({textContent: state.formatDate($i0.data.date, {\\"timeZone\\":\\"UTC\\"})}))}"]}',
      '{"innerHTML":"${state.escapeHtml(state.orBlank($map.item.data.b))}"}',
    ];
    expect(formulasUsed(texts)).toEqual(["formatDate", "orBlank", "escapeHtml"]);
    expect(Object.keys(formulaState(texts) ?? {})).toEqual(["formatDate", "orBlank", "escapeHtml"]);
    expect(formulaState(texts)?.orBlank).toBe(FORMULAS.orBlank);
    expect(formulaState(['{"textContent":"${state.entry.data.title ?? \'\'}"}'])).toBeUndefined();
    // A state entry of the page's own with a longer name is not a formula's call.
    expect(formulasUsed(["${state.orBlanket(state.a)}", "${state.notEmptyList.length}"])).toEqual(
      [],
    );
  });
});

/**
 * Where Jx's own formulas are, one directory per formula (`formula.json`, `expression.json`): the
 * package when it is installed, else a Jx checkout beside this repository (`WP2JX_JX_FORMULAS` names
 * another). The copies in `src/formulas.ts` are held to it wherever one is found.
 */
const UPSTREAM = [
  process.env.WP2JX_JX_FORMULAS,
  resolve(import.meta.dir, "../node_modules/@jxsuite/formulas/formulas"),
  resolve(import.meta.dir, "../../jx-2/packages/formulas/formulas"),
  resolve(import.meta.dir, "../../jx/packages/formulas/formulas"),
].find(
  (dir): dir is string =>
    dir !== undefined &&
    [...ALL_FORMULAS].every((name) => existsSync(join(dir, name, "expression.json"))),
);

describe("the definitions are Jx's own", () => {
  test.skipIf(UPSTREAM === undefined)(
    "each copy is its @jxsuite/formulas entry: description, parameters and expression",
    () => {
      const read = (name: string, file: string): unknown =>
        JSON.parse(readFileSync(join(UPSTREAM as string, name, file), "utf8")) as unknown;
      for (const name of ALL_FORMULAS) {
        const formula = read(name, "formula.json") as {
          name: string;
          description: string;
          parameters: unknown;
        };
        expect(formula.name).toBe(name);
        // The state entry the package itself makes of a formula (`formulaEntries`).
        expect([name, JSON.parse(JSON.stringify(FORMULAS[name])) as unknown]).toEqual([
          name,
          {
            $description: formula.description,
            parameters: formula.parameters,
            $expression: read(name, "expression.json"),
          },
        ]);
      }
    },
  );
});

describe("the definition project.json carries says what the JavaScript says", () => {
  test("notEmpty, orBlank and escapeHtml, on every kind of value", () => {
    inBrowser(() => {
      for (const v of [...VALUES, ...ZERO_LISTS]) {
        for (const name of ["notEmpty", "orBlank", "escapeHtml"] as const) {
          expect([name, show(v), interpreted(name, v)]).toEqual([name, show(v), js[name](v)]);
        }
      }
    });
  });

  test("formatDate, with and without options, and nothing for a missing date", () => {
    const options = {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "America/New_York",
    };
    for (const v of ["2024-02-15T17:30:00Z", "2023-12-31T23:30:00Z", "2024-02-15", 1708018200000]) {
      expect(interpreted("formatDate", v, options)).toBe(js.formatDate(v, options) as string);
      expect(interpreted("formatDate", v)).toBe(js.formatDate(v) as string);
    }
    expect(js.formatDate("2023-12-31T23:30:00Z", options)).toBe("December 31, 2023");
    // UTC unless the options name a zone.
    expect(js.formatDate("2023-12-31T23:30:00Z", { dateStyle: "long" })).toBe("December 31, 2023");
    expect(js.formatDate("2024-01-01T02:30:00Z", options)).toBe("December 31, 2023");
    for (const empty of [undefined, null, ""]) {
      expect(interpreted("formatDate", empty, options)).toBe("");
      expect(js.formatDate(empty, options)).toBe("");
    }
  });

  test("a formula the installed Jx is trusted with is one its interpreter answers with no window, as a build has none", () => {
    expect((globalThis as { window?: unknown }).window).toBeUndefined();
    for (const name of jxFormulas()) {
      // A date that is one: `x` is no date, and Intl throws on it with or without a window.
      expect(() => interpreted(name, name === "formatDate" ? "2024-02-15" : "x")).not.toThrow();
    }
  });
});

describe("a formula means what the expression it replaced meant", () => {
  /** The expression the converter wrote before, which it still writes where the value is not read from a path. */
  const OLD = {
    notEmpty: "((v) => !!v && v != '0' && !(Array.isArray(v) && !v.length))",
    orBlank: "((t) => t == '0' ? '' : t ?? '')",
    escapeHtml:
      "((x) => String((x) ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c])))",
  } as const;
  const old = (name: keyof typeof OLD, v: unknown): unknown =>
    (new Function(`return ${OLD[name]};`)() as (v: unknown) => unknown)(v);

  test("the expressions under test are the ones the converter writes for a value that is not a path", () => {
    expect(notEmptyExpr("f(x)")).toBe(`${OLD.notEmpty}(f(x))`);
    expect(htmlEscapeExpr("f(x)")).toBe(
      "String((f(x)) ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]))",
    );
  });

  test("notEmpty is PHP's empty() negated on every value, and the old expression on all but a list of one zero", () => {
    for (const v of [...VALUES, ...ZERO_LISTS]) {
      // NaN is the one value they read apart (falsy in JavaScript, not empty to `phpEmpty`); no
      // entry holds one, and the old expression read it as the formula does (below).
      if (Number.isNaN(v)) continue;
      expect([show(v), js.notEmpty(v)]).toEqual([show(v), !phpEmpty(v)]);
    }
    for (const v of VALUES) {
      expect([show(v), js.notEmpty(v)]).toEqual([show(v), old("notEmpty", v)]);
    }
    // `['0'] != '0'` is false in JavaScript (the list is compared as the text `0`), so the old
    // expression read a list of one zero as empty. PHP's `empty(['0'])` is false: the formula is
    // the one that agrees with the static road (`phpEmpty`).
    for (const v of ZERO_LISTS) {
      expect([show(v), old("notEmpty", v), js.notEmpty(v), phpEmpty(v)]).toEqual([
        show(v),
        false,
        true,
        false,
      ]);
    }
  });

  test("orBlank is the old expression on everything a scalar field holds; they part on a list of one zero, which no path of one holds", () => {
    for (const v of VALUES) {
      expect([show(v), js.orBlank(v)]).toEqual([show(v), old("orBlank", v)]);
    }
    for (const v of ZERO_LISTS) {
      expect(old("orBlank", v)).toBe("");
      expect(js.orBlank(v)).toBe(v);
    }
  });

  test("escapeHtml is the old expression on every value", () => {
    for (const v of [
      ...VALUES,
      ...ZERO_LISTS,
      "a&b<c>d\"e'f&amp;",
      "<script>alert('x')</script>",
    ]) {
      expect([show(v), js.escapeHtml(v)]).toEqual([show(v), old("escapeHtml", v)]);
    }
    expect(js.escapeHtml("Tom & <Jerry> \"q\" 'x'")).toBe(
      "Tom &amp; &lt;Jerry&gt; &quot;q&quot; &#39;x&#39;",
    );
  });

  test("a value with a fallback is `path || fallback`, which is what `(path ?? '') || fallback` says", () => {
    const made = orElse({ expr: "state.entry.data.x ?? ''" }, { lit: "none" });
    expect(made).toEqual({ expr: "state.entry.data.x || 'none'", html: false });
    const before = (x: unknown): unknown =>
      new Function("x", "return (x ?? '') || 'none';")(x) as unknown;
    const after = (x: unknown): unknown => new Function("x", "return x || 'none';")(x) as unknown;
    for (const v of [...VALUES, ...ZERO_LISTS]) {
      expect([show(v), after(v)]).toEqual([show(v), before(v)]);
    }
    // Anything that is not read from a path keeps its parentheses.
    expect(orElse({ expr: "state.a ? '1' : ''" }, { lit: "none" })).toEqual({
      expr: "(state.a ? '1' : '') || 'none'",
      html: false,
    });
  });
});

describe("dates: formatDate prints what dateExpr prints", () => {
  async function ctxFor(language: string, zone: string): Promise<ConvertCtx> {
    const ctx = await makeCtx("ap", { kind: "post", id: 773 }, { mode: "entry" });
    const fixed = zone.startsWith("+") || zone.startsWith("-");
    const hours = fixed
      ? Number(zone.slice(0, 3)) +
        Math.sign(Number(zone.slice(0, 3))) * (Number(zone.slice(4)) / 60)
      : 0;
    return Object.assign(Object.create(ctx) as ConvertCtx, {
      model: {
        ...ctx.model,
        site: { ...ctx.model.site, language },
        options: new Map([
          ...ctx.model.options,
          ["timezone_string", fixed || zone === "UTC" ? "" : zone],
          ["gmt_offset", fixed ? String(hours) : "0"],
        ]),
      },
    });
  }

  /** What the converter wrote for a date before: nothing for a missing one, else `dateExpr`. */
  const oldDate = (ctx: ConvertCtx, format: string, zone?: string): ((d: unknown) => string) =>
    new Function("d", `return (d) ? ${dateExpr(ctx, format, "d", zone).expr} : '';`) as (
      d: unknown,
    ) => string;

  /** The formula call for the same date, evaluated the way the build does, in a page of `language`. */
  const newDate = (tag: string, language: string): ((d: unknown) => string) => {
    const run = new Function("state", `return ${tag};`) as (s: unknown) => string;
    return (d) => run(withFormulas({ d, $page: { locale: language } }));
  };

  test("the site is in en-US and America/New_York, as the committed fixture says", async () => {
    const site = await loadSite("ap");
    expect(site.model.site.language).toBe("en-US");
    expect(site.model.options.get("timezone_string")).toBe("America/New_York");
  });

  test("every date and modified date of the anabaptistperspectives fixture, in the site's format and zone", async () => {
    const site = await loadSite("ap");
    const ctx = await ctxFor("en-US", "America/New_York");
    const tag = dateTag(ctx, "F j, Y", "state.d");
    expect(tag).toBe(
      'state.formatDate(state.d, {"year":"numeric","month":"long","day":"numeric","timeZone":"America/New_York"})',
    );
    const before = oldDate(ctx, "F j, Y");
    const after = newDate(tag as string, "en-US");
    const dates = new Set<string>();
    for (const post of site.model.posts.values()) {
      if (post.status !== "publish") continue;
      const data = postData(ctx, post);
      for (const d of [data.date, data.modified]) if (typeof d === "string") dates.add(d);
    }
    expect(dates.size).toBeGreaterThan(100);
    for (const d of dates) {
      const printed = after(d);
      expect([d, printed]).toEqual([d, before(d)]);
      // And both are what the static road prints for the instant.
      expect(printed).toBe(formatDate(ctx, "F j, Y", Date.parse(d)));
    }
    // 2020-12-20T06:49:00Z is 1:49 in the morning in New York: the post's own day there.
    expect(after("2020-12-20T06:49:00.000Z")).toBe("December 20, 2020");
    expect(after("2020-12-20T03:49:00.000Z")).toBe("December 19, 2020");
  });

  test("a missing or empty date prints nothing either way", async () => {
    const ctx = await ctxFor("en-US", "America/New_York");
    const before = oldDate(ctx, "F j, Y");
    const after = newDate(dateTag(ctx, "F j, Y", "state.d") as string, "en-US");
    for (const empty of [undefined, null, ""]) {
      expect(before(empty)).toBe("");
      expect(after(empty)).toBe("");
    }
  });

  test("every format Intl writes whole, in its own locale, in every kind of zone, on instants that try the edges", async () => {
    const instants = [
      "2024-02-29T12:00:00Z",
      "2024-01-01T00:00:00Z",
      "2023-12-31T23:59:59Z",
      "2024-03-10T06:59:59Z",
      "2024-03-10T07:00:00Z",
      "2024-11-03T05:59:59Z",
      "2024-11-03T06:00:00Z",
      "2021-05-09T03:04:05Z",
      "2019-09-01T12:00:00Z",
      "1999-12-31T23:59:59Z",
      "2024-10-05",
      "2024-01-09",
    ];
    for (let day = 1; day <= 31; day++) {
      instants.push(`2022-07-${String(day).padStart(2, "0")}T15:00:00Z`);
    }
    for (let month = 1; month <= 12; month++) {
      instants.push(`2023-${String(month).padStart(2, "0")}-15T04:30:00Z`);
    }
    let checked = 0;
    for (const [format, [language]] of Object.entries(INTL_FORMATS)) {
      for (const zone of [
        "America/New_York",
        "Europe/London",
        "Asia/Kolkata",
        "UTC",
        "+05:30",
        "-04:00",
      ]) {
        const ctx = await ctxFor(language, zone);
        const tag = dateTag(ctx, format, "state.d");
        expect([format, zone, typeof tag]).toEqual([format, zone, "string"]);
        const before = oldDate(ctx, format);
        const after = newDate(tag as string, language);
        for (const d of instants) {
          expect([format, zone, d, after(d)]).toEqual([format, zone, d, before(d)]);
          checked++;
        }
      }
      // A date picker's day, formatted in UTC whatever the site's zone.
      const ctx = await ctxFor(language, "America/New_York");
      const tag = dateTag(ctx, format, "state.d", "UTC") as string;
      expect(tag).toContain('"timeZone":"UTC"');
      const before = oldDate(ctx, format, "UTC");
      const after = newDate(tag, language);
      for (const d of ["2024-10-05", "2024-01-01", "2023-12-31"]) {
        expect([format, d, after(d)]).toEqual([format, d, before(d)]);
      }
    }
    expect(checked).toBe(5 * 6 * instants.length);
  });

  test("it is not written where it would print something else: another language, another format, a value that is not a path", async () => {
    const us = await ctxFor("en-US", "America/New_York");
    const gb = await ctxFor("en-GB", "Europe/London");
    const de = await ctxFor("de-DE", "Europe/Berlin");
    // The formula formats in the page's locale, and `F j, Y` is en-US's long date alone.
    expect(dateTag(gb, "F j, Y", "state.d")).toBeUndefined();
    expect(dateTag(de, "F j, Y", "state.d")).toBeUndefined();
    expect(dateTag(us, "j F Y", "state.d")).toBeUndefined();
    expect(dateTag(gb, "j F Y", "state.d")).toBeDefined();
    // en-GB's own long date is not PHP's `F j, Y`: this is what the gate prevents.
    expect(
      newDate(dateTag(us, "F j, Y", "state.d") as string, "en-GB")("2024-02-15T17:30:00Z"),
    ).toBe("15 February 2024");
    for (const format of ["Y-m-d", "l, jS \\o\\f F", "d.m.Y", "F jS, Y", "g:i a", ""]) {
      expect([format, dateTag(us, format, "state.d")]).toEqual([format, undefined]);
    }
    expect(dateTag(us, "F j, Y", "Date.now()")).toBeUndefined();
    expect(dateTag(us, "F j, Y", "(state.d) ?? ''")).toBeUndefined();
    expect(intlDateOptions("F j, Y", "en_US", "UTC")).toEqual({
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  });
});

describe("a call written out as JavaScript", () => {
  const every = ALL_FORMULAS;

  test("means the same: every formula, nested, beside other text, and inside the item of a computed list", () => {
    const options = { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
    const templates = [
      `\${${formulaCall("formatDate", "state.entry.data.date", options)}}`,
      `\${!${formulaCall("notEmpty", "state.entry.data.zero")}}`,
      `\${${formulaCall("orBlank", "state.entry.data.zero")} || 'none'}`,
      `a \${${formulaCall("escapeHtml", formulaCall("orBlank", "state.entry.data.amp"))}} b`,
      `\${${formulaCall("escapeHtml", "state.entry.data.amp")}.replace(/x/g, m => '(' + m + ')')}`,
      `\${(state.rows ?? []).map(($i0, $x0) => ($x0 + ':' + ${formulaCall("formatDate", "$i0.date", options)} + ${formulaCall("escapeHtml", "$i0.name")})).join(' ')}`,
    ];
    const state = {
      entry: { data: { date: "2024-02-15T17:30:00Z", zero: "0", amp: "x & <y>" } },
      rows: [
        { date: "2023-12-31T23:30:00Z", name: "A&B" },
        { date: "", name: "C" },
      ],
    };
    const evaluate = (template: string, scope: unknown): unknown =>
      new Function("state", `return \`${template}\`;`)(scope) as unknown;
    for (const template of templates) {
      const lowered = lowerFormulas(template, every);
      expect(lowered).not.toMatch(/state\.(formatDate|notEmpty|orBlank|escapeHtml)\(/);
      // The lowered text needs no formula in its state; the call needs them all.
      expect([template, evaluate(lowered, state)]).toEqual([
        template,
        evaluate(template, withFormulas(state)),
      ]);
    }
    expect(evaluate(lowerFormulas(templates[5] as string, every), state)).toBe(
      "0:Dec 31, 2023A&amp;B 1:C",
    );
  });

  test("a date written out where the state has no page (a component) is in the project's language, not en-US", () => {
    const options = { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" };
    const template = `\${${formulaCall("formatDate", "state.when", options)}}`;
    const evaluate = (text: string, scope: unknown): unknown =>
      new Function("state", `return \`${text}\`;`)(scope) as unknown;
    const component = { when: "2024-02-15T17:30:00Z" };
    expect(evaluate(lowerFormulas(template, every, "en-GB"), component)).toBe("15 February 2024");
    expect(evaluate(lowerFormulas(template, every, "en_GB"), component)).toBe("15 February 2024");
    expect(evaluate(lowerFormulas(template, every, "en-US"), component)).toBe("February 15, 2024");
    expect(evaluate(lowerFormulas(template, every), component)).toBe("February 15, 2024");
    // A page's own locale still comes first, as it does for the formula.
    expect(
      evaluate(lowerFormulas(template, every, "en-GB"), {
        ...component,
        $page: { locale: "en-US" },
      }),
    ).toBe("February 15, 2024");
    // Only a language tag is written into the source; anything else leaves the default.
    expect(formulaJs("formatDate", "x'); alert(1); ('")).toBe(FORMULA_JS.formatDate);
    expect(formulaJs("formatDate", "")).toBe(FORMULA_JS.formatDate);
    expect(formulaJs("escapeHtml", "en-GB")).toBe(FORMULA_JS.escapeHtml);
    // settleFormulas passes the language on to a component's calls, and writes a date out there
    // even where a component can call the project's formulas: the formula would format in en-US.
    const settled = settleFormulas(
      [["components/x-date.json", JSON.stringify({ tagName: "x-date", textContent: template })]],
      every,
      "en-GB",
      true,
    );
    const written = JSON.parse(settled.changed.get("components/x-date.json") as string) as {
      textContent: string;
    };
    expect(evaluate(written.textContent, component)).toBe("15 February 2024");
  });

  test("only the formulas named are written out, and a document's keys are left alone", () => {
    const doc = {
      "state.orBlank(": "a key, not a binding",
      textContent: "${state.orBlank(state.a) || state.escapeHtml(state.b)}",
      children: [{ innerHTML: "${state.escapeHtml(state.c)}" }, 7, null],
    };
    const out = lowerFormulasIn(doc, new Set<FormulaName>(["escapeHtml"]));
    expect(Object.keys(out)).toEqual(Object.keys(doc));
    expect(out.textContent).toBe(
      `\${state.orBlank(state.a) || (${FORMULA_JS.escapeHtml})(state.b)}`,
    );
    expect(out.children).toEqual([
      { innerHTML: `\${(${FORMULA_JS.escapeHtml})(state.c)}` },
      7,
      null,
    ]);
    // A call that never closes is not one the converter wrote.
    expect(lowerFormulas("${state.orBlank(state.a", every)).toBe("${state.orBlank(state.a");
  });

  test("the JavaScript holds nothing the build's reading of a binding trips over: its braces balance and it has no backtick", () => {
    for (const name of every) {
      const source = FORMULA_JS[name];
      expect(source).not.toContain("`");
      expect(source).not.toContain("${");
      let depth = 0;
      for (const c of source) {
        if (c === "{") depth++;
        if (c === "}") depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
      }
      expect(depth).toBe(0);
    }
  });

  test("settling a project for a Jx whose components cannot call a project formula: a component's calls are always written out, a page's only for a formula the build is not trusted with, and project.json holds the rest", () => {
    const page = JSON.stringify({
      children: [
        {
          tagName: "time",
          textContent: '${state.formatDate(state.entry.data.date, {"timeZone":"UTC"})}',
        },
        { tagName: "p", attributes: { hidden: "${!state.notEmpty(state.entry.data.about)}" } },
      ],
    });
    const component = JSON.stringify({
      tagName: "x-card",
      children: [{ tagName: "i", innerHTML: "${state.escapeHtml(state.label)}" }],
    });
    const documents: [string, string][] = [
      ["components/x-card.json", component],
      ["pages/index.json", page],
      ["content/posts/a.md", "---\ntitle: a\n---\n\n${state.escapeHtml(state.x)}\n"],
      ["pages/plain.json", JSON.stringify({ children: [{ tagName: "p", textContent: "hi" }] })],
    ];
    // Every formula trusted: the page keeps its calls and the project holds exactly those two.
    const all = settleFormulas(documents, every, undefined, false);
    expect([...all.changed.keys()]).toEqual(["components/x-card.json"]);
    expect(all.changed.get("components/x-card.json")).not.toContain("state.escapeHtml(");
    expect(Object.keys(all.state ?? {})).toEqual(["formatDate", "notEmpty"]);
    expect(all.lowered).toEqual(["escapeHtml"]);
    // One trusted: the other is written out in the page, and the project holds the one.
    const some = settleFormulas(documents, new Set<FormulaName>(["formatDate"]), undefined, false);
    expect([...some.changed.keys()].sort()).toEqual(["components/x-card.json", "pages/index.json"]);
    expect(some.changed.get("pages/index.json")).toContain("state.formatDate(");
    expect(some.changed.get("pages/index.json")).not.toContain("state.notEmpty(");
    expect(Object.keys(some.state ?? {})).toEqual(["formatDate"]);
    // None trusted: no call is left anywhere, and project.json gets no state.
    const none = settleFormulas(documents, new Set(), undefined, false);
    expect(none.state).toBeUndefined();
    for (const text of none.changed.values()) {
      expect(text).not.toMatch(/state\.(formatDate|notEmpty|orBlank|escapeHtml)\(/);
      expect(() => JSON.parse(text) as unknown).not.toThrow();
    }
    expect(none.lowered).toEqual(["formatDate", "notEmpty", "escapeHtml"]);
  });

  describe("settling a project for a Jx whose components call the project's formulas (jxsuite/jx#642)", () => {
    const card = (extra: Record<string, unknown> = {}): string =>
      JSON.stringify({
        tagName: "x-card",
        ...extra,
        children: [
          { tagName: "i", innerHTML: "${state.escapeHtml(state.label)}" },
          {
            tagName: "time",
            textContent: '${state.formatDate(state.when, {"dateStyle":"long"})}',
          },
          { tagName: "b", attributes: { hidden: "${!state.notEmpty(state.label)}" } },
        ],
      });
    const page = JSON.stringify({
      children: [{ tagName: "p", textContent: "${state.orBlank(state.entry.data.x) || 'none'}" }],
    });

    test("a component keeps its calls as a page does, and project.json holds every formula either calls", () => {
      const documents: [string, string][] = [
        ["components/x-card.json", card()],
        ["pages/index.json", page],
      ];
      for (const language of [undefined, "en-US", "en_US"]) {
        const settled = settleFormulas(documents, every, language, true);
        expect([language, [...settled.changed.keys()]]).toEqual([language, []]);
        expect(Object.keys(settled.state ?? {})).toEqual([
          "formatDate",
          "notEmpty",
          "orBlank",
          "escapeHtml",
        ]);
        expect(settled.lowered).toEqual([]);
      }
      // A formula the build is not trusted with is written out in a component as in a page, and
      // the project holds only what is still called.
      const some = settleFormulas(documents, new Set<FormulaName>(["escapeHtml"]), "en-US", true);
      const written = some.changed.get("components/x-card.json") as string;
      expect(written).toContain("state.escapeHtml(state.label)");
      expect(written).not.toMatch(/state\.(formatDate|notEmpty)\(/);
      expect(Object.keys(some.state ?? {})).toEqual(["escapeHtml"]);
      expect(some.lowered).toEqual(["formatDate", "notEmpty", "orBlank"]);
    });

    test("a date in a component is written out where the project's language is not Jx's default, which is what a formula formats in there", () => {
      const settled = settleFormulas([["components/x-card.json", card()]], every, "en-GB", true);
      const written = settled.changed.get("components/x-card.json") as string;
      expect(written).not.toContain("state.formatDate(");
      expect(written).toContain("'en-GB'");
      expect(written).toContain("state.escapeHtml(state.label)");
      expect(written).toContain("state.notEmpty(state.label)");
      expect(Object.keys(settled.state ?? {})).toEqual(["notEmpty", "escapeHtml"]);
      expect(settled.lowered).toEqual(["formatDate"]);
    });

    test("a component whose own state has an entry of a formula's name has that call written out: its own entry is what the call would reach", () => {
      const own = card({ state: { label: "", escapeHtml: "a prop of the same name" } });
      const settled = settleFormulas([["components/x-card.json", own]], every, "en-US", true);
      const written = JSON.parse(settled.changed.get("components/x-card.json") as string) as {
        state: Record<string, unknown>;
        children: { innerHTML?: string }[];
      };
      expect(written.state).toEqual({ label: "", escapeHtml: "a prop of the same name" });
      expect(written.children[0]?.innerHTML).toBe(`\${(${FORMULA_JS.escapeHtml})(state.label)}`);
      expect(JSON.stringify(written)).toContain("state.formatDate(");
      expect(settled.lowered).toEqual(["escapeHtml"]);
      // The project's formula is still there for what calls it.
      expect(Object.keys(settled.state ?? {})).toEqual(["formatDate", "notEmpty"]);
    });

    test("a component that does not read as JSON is left alone, as before", () => {
      const settled = settleFormulas(
        [["components/x-card.json", "{ state.escapeHtml(state.label)"]],
        every,
        "en-US",
        true,
      );
      expect(settled.changed.size).toBe(0);
      expect(settled.state).toBeUndefined();
    });

    test("the default asks the installed Jx (jxComponentFormulas), which the build tests hold to the build", () => {
      const documents: [string, string][] = [["components/x-card.json", card()]];
      expect(settleFormulas(documents, every, "en-US")).toEqual(
        settleFormulas(documents, every, "en-US", jxComponentFormulas()),
      );
    });
  });
});
