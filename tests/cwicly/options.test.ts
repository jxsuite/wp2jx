/**
 * The Cwicly options reader, against both fixture sites' real option rows.
 *
 * What the rows say is checked three ways that do not go through the reader: the raw JSON re-parsed
 * here, the stylesheets the sites actually serve (`tests/fixtures/<site>/css`), and the pages they
 * actually render (`tests/fixtures/<site>/html`). Hand-written inputs cover what neither fixture has
 * (min-width breakpoints, local fonts, conditions, damaged values); the local-font and condition
 * shapes are copied from a third live site's options and abridged.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { parse } from "@wordpress/block-serialization-default-parser";
import { buildSiteStyleCSS } from "@jxsuite/site/site-style";
import postcss from "postcss";
import type { Report, ReportEntry } from "../../src/types.ts";
import { CSS_ARTIFACT, parseCwiclyCss } from "../../src/cwicly/css.ts";
import {
  BUILTIN_PSEUDOS,
  decodeOption,
  readCwiclyOptions,
  resolvePaletteRefs,
  type CwiclyOptionsFull,
} from "../../src/cwicly/options.ts";
import { fixtureDir, readFixtureJson, readFixtureText } from "../helpers/fixture-db.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────

const SITES = ["fineline", "ap"] as const;
type Site = (typeof SITES)[number];

interface OptionRow {
  option_name: string;
  option_value: string;
}

const optionCache = new Map<Site, Map<string, string>>();
function optionsOf(site: Site): Map<string, string> {
  let options = optionCache.get(site);
  if (!options) {
    const rows = readFixtureJson<OptionRow[]>(site, "rows/options.json");
    options = new Map(rows.map((r) => [r.option_name, r.option_value]));
    optionCache.set(site, options);
  }
  return options;
}

/** A Cwicly option whose stored value is JSON, parsed here without the reader. */
function rawJson<T = any>(site: Site, name: string): T {
  const value = optionsOf(site).get(name);
  if (value === undefined) throw new Error(`${site} has no ${name}`);
  return JSON.parse(value) as T;
}

function collector() {
  const entries: ReportEntry[] = [];
  const report: Report = { add: (e) => void entries.push(e), entries: () => entries };
  return { entries, report };
}

interface Loaded {
  options: Map<string, string>;
  result: CwiclyOptionsFull;
  entries: ReportEntry[];
}

function read(options: Map<string, string>): Loaded {
  const { entries, report } = collector();
  return { options, result: readCwiclyOptions(options, report), entries };
}

const real = Object.fromEntries(SITES.map((site) => [site, read(optionsOf(site))])) as Record<
  Site,
  Loaded
>;

/** An options table holding just these entries. */
const table = (entries: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(entries));

const codesOf = (entries: readonly ReportEntry[]) => entries.map((e) => e.code);
/** The classes the report says the editor's cache is missing or holds for classes that are gone. */
const staleData = (entries: readonly ReportEntry[]) =>
  (entries.find((e) => e.code === "option.stale")?.data ?? { uncached: [], orphaned: [] }) as {
    uncached: string[];
    orphaned: string[];
  };
const withCode = (entries: readonly ReportEntry[], code: string) =>
  entries.filter((e) => e.code === code);

/** PHP's `serialize`, written out so hand-built inputs do not lean on the library the reader uses. */
function php(value: unknown): string {
  if (value === null) return "N;";
  if (typeof value === "boolean") return `b:${value ? 1 : 0};`;
  if (typeof value === "number") return Number.isInteger(value) ? `i:${value};` : `d:${value};`;
  if (typeof value === "string") return `s:${Buffer.byteLength(value)}:"${value}";`;
  const entries = Array.isArray(value)
    ? value.map((v, i) => [i, v] as const)
    : Object.entries(value as Record<string, unknown>);
  const body = entries
    .map(([k, v]) => `${typeof k === "number" ? `i:${k};` : php(k)}${php(v)}`)
    .join("");
  return `a:${entries.length}:{${body}}`;
}

const cssFiles = (site: Site) =>
  readdirSync(`${fixtureDir(site)}/css`).filter((f) => f.endsWith(".css"));
const htmlPages = (site: Site) =>
  readdirSync(`${fixtureDir(site)}/html`)
    .filter((f) => f.endsWith(".html"))
    .map((f) => ({ name: f, html: readFixtureText(site, `html/${f}`) }));

/** What every result must satisfy however damaged its options were. */
function wellFormed(r: CwiclyOptionsFull): void {
  expect(r.breakpoints.length).toBeGreaterThan(0);
  expect(r.breakpoints.filter((b) => b.direction === "none")).toHaveLength(1);
  for (const b of r.breakpoints) expect(b.isMain).toBe(b.direction === "none");
  for (const b of r.breakpoints) expect(Number.isFinite(b.width)).toBe(true);
  expect(Object.values(r.media).every((v) => typeof v === "string")).toBe(true);
  expect(Array.isArray(r.globalStyles.colors)).toBe(true);
  expect(r.globalStyles.colorsById).toBeInstanceOf(Map);
  expect(r.globalStyles.colorsBySlug).toBeInstanceOf(Map);
  expect(r.globalStyles.colorsByLegacySlug).toBeInstanceOf(Map);
  expect(r.globalStyles.colorRefs).toBeInstanceOf(Map);
  expect(Array.isArray(r.globalStyles.gradients)).toBe(true);
  expect(Array.isArray(r.globalStyles.globalElements)).toBe(true);
  expect(typeof r.optimise.removeContainerDisplay).toBe("boolean");
  expect(Array.isArray(r.globalStyles.fonts)).toBe(true);
  expect(
    typeof r.compiledCss.global + typeof r.compiledCss.classes + typeof r.compiledCss.stylesheets,
  ).toBe("stringstringstring");
  expect(r.globalClassNames).toBeInstanceOf(Map);
  expect([...r.globalClassNames.values()].every((n) => typeof n === "string" && n !== "")).toBe(
    true,
  );
  expect(r.globalClassAttrs.size).toBe(r.globalClassNames.size);
  expect(typeof r.customCode.head + typeof r.customCode.bodyOpen + typeof r.customCode.footer).toBe(
    "stringstringstring",
  );
  expect(Array.isArray(r.templateRules)).toBe(true);
  expect(Array.isArray(r.fragments)).toBe(true);
  expect(Array.isArray(r.customPseudos)).toBe(true);
  expect(typeof r.darkMode.darkSelectors).toBe("string");
  expect(typeof r.tailwind).toBe("boolean");
  expect(() => JSON.stringify(r.globalStyles.colors)).not.toThrow();
}

const BP_LIST = "cwicly_breakpoints_list";
const bpTable = (list: unknown) => table({ [BP_LIST]: JSON.stringify(list) });

/** `cwicly_global_styles` holding these styles, with `activeStyle` naming one of them. */
const stylesTable = (
  styles: Record<string, unknown>,
  activeStyle = "style1",
  more: Record<string, string> = {},
): Map<string, string> =>
  table({ cwicly_global_styles: JSON.stringify({ activeStyle, styles }), ...more });

// ── Tolerant decoding ────────────────────────────────────────────────────────────────────────────

describe("decodeOption", () => {
  test("a missing row is absent and a blank value is empty", () => {
    expect(decodeOption(undefined)).toEqual({ kind: "absent" });
    expect(decodeOption(null)).toEqual({ kind: "absent" });
    expect(decodeOption("")).toEqual({ kind: "empty" });
    expect(decodeOption(" \n\t")).toEqual({ kind: "empty" });
  });

  test("JSON in every shape the editor writes", () => {
    expect(decodeOption('{"lg":{"width":1366}}')).toEqual({
      kind: "value",
      format: "json",
      value: { lg: { width: 1366 } },
    });
    expect(decodeOption(" [1,2] ")).toMatchObject({ format: "json", value: [1, 2] });
    expect(decodeOption('"text"')).toMatchObject({ format: "json", value: "text" });
    expect(decodeOption("true")).toMatchObject({ format: "json", value: true });
    expect(decodeOption("null")).toMatchObject({ format: "json", value: null });
    expect(decodeOption("12")).toMatchObject({ format: "json", value: 12 });
    expect(decodeOption("-1.5e3")).toMatchObject({ format: "json", value: -1500 });
  });

  test("PHP-serialised values, including the empty array that isSerialized() misses", () => {
    expect(decodeOption("a:0:{}")).toEqual({ kind: "value", format: "php", value: [] });
    expect(decodeOption('a:2:{i:0;s:1:"x";i:1;s:1:"y";}')).toMatchObject({ value: ["x", "y"] });
    expect(decodeOption('a:2:{s:2:"md";i:992;s:2:"sm";i:576;}')).toMatchObject({
      value: { md: 992, sm: 576 },
    });
    expect(decodeOption("b:1;")).toMatchObject({ format: "php", value: true });
    expect(decodeOption("d:1.5;")).toMatchObject({ format: "php", value: 1.5 });
    expect(decodeOption("N;")).toMatchObject({ format: "php", value: null });
    expect(decodeOption(php({ a: [1, { b: null }], c: false }))).toMatchObject({
      value: { a: [1, { b: null }], c: false },
    });
  });

  test("PHP string lengths are bytes, so a multibyte string survives", () => {
    expect(decodeOption('s:6:"héllo";')).toMatchObject({ value: "héllo" });
    expect(decodeOption(php({ title: "Réunion – 日本語" }))).toMatchObject({
      value: { title: "Réunion – 日本語" },
    });
  });

  test("plain text is returned as written, including CSS that begins like a PHP tag", () => {
    for (const text of [
      "1.4.7",
      "<link rel='stylesheet' href='x'>",
      "body{color:red}",
      "a:hover{color:red}",
    ]) {
      expect(decodeOption(text)).toEqual({ kind: "value", format: "text", value: text });
    }
  });

  test("a layer of double encoding is unwrapped, a plain JSON string is not", () => {
    expect(decodeOption(JSON.stringify(JSON.stringify({ a: 1 })))).toMatchObject({
      value: { a: 1 },
    });
    expect(decodeOption(php('{"a":1}'))).toMatchObject({ format: "json", value: { a: 1 } });
    expect(decodeOption(php(php({ a: 1 })))).toMatchObject({ format: "php", value: { a: 1 } });
    expect(decodeOption('"hello"')).toMatchObject({ value: "hello" });
    expect(decodeOption(php("hello"))).toMatchObject({ format: "php", value: "hello" });
  });

  test("a string that only looks like another layer is the string, not a failure", () => {
    expect(decodeOption(JSON.stringify("{not json"))).toEqual({
      kind: "value",
      format: "json",
      value: "{not json",
    });
    expect(decodeOption(JSON.stringify("[1,"))).toEqual({
      kind: "value",
      format: "json",
      value: "[1,",
    });
    expect(decodeOption(php("a:1:{broken"))).toEqual({
      kind: "value",
      format: "php",
      value: "a:1:{broken",
    });
  });

  test("a value that looks structured but is not comes back invalid, never thrown", () => {
    expect(decodeOption('{"a":')).toMatchObject({ kind: "invalid", format: "json", raw: '{"a":' });
    expect(decodeOption('a:2:{i:0;s:1:"x";')).toMatchObject({ kind: "invalid", format: "php" });
    expect(decodeOption("a:4294967295:{}")).toMatchObject({ kind: "invalid", format: "php" });
    expect(decodeOption("a:1:{i:0;".repeat(20000))).toMatchObject({ kind: "invalid" });
  });

  test("a value that was already parsed passes through", () => {
    expect(decodeOption({ a: [1] })).toEqual({
      kind: "value",
      format: "native",
      value: { a: [1] },
    });
    expect(decodeOption(5)).toEqual({ kind: "value", format: "native", value: 5 });
    expect(decodeOption(false)).toEqual({ kind: "value", format: "native", value: false });
  });

  test("an already-parsed value that is hostile (a cycle, a throwing getter) is invalid, not thrown", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(decodeOption(cycle)).toMatchObject({ kind: "invalid" });
    const getter = {
      get boom(): string {
        throw new Error("getter exploded");
      },
    };
    expect(decodeOption(getter)).toMatchObject({ kind: "invalid", error: "getter exploded" });
    const noString = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(noString, "x", {
      get() {
        throw noString;
      },
      enumerable: true,
    });
    expect(decodeOption(noString)).toMatchObject({ kind: "invalid", error: "unknown error" });
    const { result } = read(new Map<string, string>([["cwicly_global_classes", cycle as never]]));
    expect(result.globalClassNames.size).toBe(0);
  });

  test("a PHP integer too big for a double becomes a string, not a BigInt", () => {
    expect(decodeOption("i:42;")).toMatchObject({ value: 42 });
    expect(decodeOption("i:12345678901234567890;")).toMatchObject({
      value: "12345678901234567890",
    });
  });

  test("Cwicly options are not all JSON: which dialect each real option is stored in", () => {
    const dialect = (site: Site, name: string) => {
      const d = decodeOption(optionsOf(site).get(name));
      return d.kind === "value" ? d.format : d.kind;
    };
    const JSON_OPTIONS = [
      "cwicly_breakpoints_list",
      "cwicly_global_styles",
      "cwicly_global_classes",
      "cwicly_conditions",
      "cwicly_pre_conditions",
      "cwicly_custom_code",
      "cwicly_global_stylesheets",
    ];
    // What `update_option()` wrote from a PHP array rather than a JSON string.
    const PHP_OPTIONS = [
      "cwicly_global_parts",
      "cwicly_global_classes_rendered",
      "cwicly_optimise",
      "cwicly_deprecated",
      "cwicly_section_defaults",
    ];
    for (const site of SITES) {
      for (const name of JSON_OPTIONS) expect(dialect(site, name), `${site} ${name}`).toBe("json");
      for (const name of PHP_OPTIONS) expect(dialect(site, name), `${site} ${name}`).toBe("php");
      for (const name of ["cwicly_global_css", "cwicly_global_fonts", "cwicly_db_version"]) {
        expect(dialect(site, name), `${site} ${name}`).toBe("text");
      }
    }
    expect(dialect("ap", "cwicly_breakpoints")).toBe("php");
  });

  test("a PHP object of a class this process has never heard of decodes to its properties", () => {
    const d = decodeOption('O:8:"stdClass":2:{s:1:"a";i:1;s:1:"b";a:1:{i:0;s:1:"x";}}');
    expect(d).toMatchObject({ kind: "value", format: "php", value: { a: 1, b: ["x"] } });
    expect(JSON.parse(JSON.stringify((d as { value: unknown }).value))).toMatchObject({
      a: 1,
      b: ["x"],
    });
  });

  test("a key named __proto__ stays data and pollutes nothing", () => {
    const json = decodeOption('{"__proto__":{"polluted":1}}');
    const serial = decodeOption(php({ __proto__: { polluted: 1 } }));
    for (const d of [json, serial]) {
      expect(d.kind).toBe("value");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
    expect(Object.keys((json as { value: object }).value)).toEqual(["__proto__"]);
  });

  test("every option row of both sites decodes; JSON rows match a plain JSON.parse", () => {
    let json = 0;
    let serialised = 0;
    for (const site of SITES) {
      for (const [name, value] of optionsOf(site)) {
        const d = decodeOption(value);
        expect(d.kind, `${site} ${name}`).not.toBe("invalid");
        let parsed: unknown;
        let isJson = true;
        try {
          parsed = JSON.parse(value);
        } catch {
          isJson = false;
        }
        if (isJson && value.trim() !== "") {
          expect(d, `${site} ${name}`).toMatchObject({ format: "json", value: parsed });
          json++;
        } else if (d.kind === "value" && d.format === "php") {
          serialised++;
        }
      }
    }
    // Both dialects really occur in the corpus, so this is not vacuous.
    expect(json).toBeGreaterThan(40);
    expect(serialised).toBeGreaterThan(40);
  });
});

// ── Breakpoints ──────────────────────────────────────────────────────────────────────────────────

describe("breakpoints and the $media map", () => {
  for (const site of SITES) {
    test(`${site}: lg 1366 is the main breakpoint, md 992 and sm 576 are max-width`, () => {
      const { result, entries } = real[site];
      expect(result.breakpoints).toEqual([
        { key: "lg", width: 1366, isMain: true, direction: "none", name: "Desktop" },
        { key: "md", width: 992, isMain: false, direction: "max", name: "Tablet" },
        { key: "sm", width: 576, isMain: false, direction: "max", name: "Mobile" },
      ]);
      expect(result.media).toEqual({
        "--": "1366px",
        "--md": "(max-width: 992px)",
        "--sm": "(max-width: 576px)",
      });
      expect(Object.keys(result.media)).toEqual(["--", "--md", "--sm"]);
      expect(codesOf(entries)).not.toContain("option.default");
    });

    test(`${site}: the stored list says the same, read without the reader`, () => {
      const list = rawJson<Record<string, { width: number; isMain?: boolean }>>(site, BP_LIST);
      const keys = Object.keys(list);
      expect(real[site].result.breakpoints.map((b) => b.key)).toEqual(keys);
      expect(real[site].result.breakpoints.map((b) => b.width)).toEqual(
        keys.map((k) => list[k]!.width),
      );
      expect(real[site].result.breakpoints.filter((b) => b.isMain).map((b) => b.key)).toEqual(
        keys.filter((k) => list[k]!.isMain),
      );
    });

    test(`${site}: the media queries of every served stylesheet are exactly its non-main breakpoints`, () => {
      const queries = new Set<string>();
      for (const file of cssFiles(site)) {
        postcss.parse(readFixtureText(site, `css/${file}`)).walkAtRules("media", (rule) => {
          for (const m of rule.params.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)) {
            queries.add(`${m[1]}-width:${m[2]}`);
          }
        });
      }
      const expected = real[site].result.breakpoints
        .filter((b) => b.direction !== "none")
        .map((b) => `${b.direction}-width:${b.width}`);
      expect([...queries].sort()).toEqual(expected.sort());
    });
  }

  test("Jx's own site-style emitter reads the media map as the design says", () => {
    const { media } = real.fineline.result;
    const css = buildSiteStyleCSS(
      { ".card": { padding: "1rem", "@--md": { padding: ".5rem" }, "@--sm": { padding: "0" } } },
      media,
      (v) => v,
    );
    expect(css.split("\n")).toEqual([
      ".card { padding: 1rem }",
      "@media (max-width: 992px) { .card { padding: .5rem } }",
      "@media (max-width: 576px) { .card { padding: 0 } }",
    ]);
  });

  test("breakpoints listed before the main one are min-width, ascending, ahead of it", () => {
    const { result } = read(
      bpTable({
        "2xl": { width: 2200 },
        xl: { width: 1920 },
        lg: { width: 1366, isMain: true },
        sm: { width: 576 },
        md: { width: 992 },
        xs: { width: 400 },
      }),
    );
    expect(result.breakpoints.map((b) => [b.key, b.direction, b.width])).toEqual([
      ["xl", "min", 1920],
      ["2xl", "min", 2200],
      ["lg", "none", 1366],
      ["md", "max", 992],
      ["sm", "max", 576],
      ["xs", "max", 400],
    ]);
    expect(Object.entries(result.media)).toEqual([
      ["--xl", "(min-width: 1920px)"],
      ["--2xl", "(min-width: 2200px)"],
      ["--", "1366px"],
      ["--md", "(max-width: 992px)"],
      ["--sm", "(max-width: 576px)"],
      ["--xs", "(max-width: 400px)"],
    ]);
    const css = buildSiteStyleCSS(
      { ".c": { color: "red", "@--xl": { color: "green" }, "@--sm": { color: "blue" } } },
      result.media,
      (v) => v,
    );
    expect(css).toContain("@media (min-width: 1920px) { .c { color: green } }");
    expect(css).toContain("@media (max-width: 576px) { .c { color: blue } }");
  });

  test("the Tailwind preset: string widths, every breakpoint min-width, a base of width 0 declares no `--`", () => {
    const { result, entries } = read(
      bpTable({
        "2xl": { name: "2xl", width: "1536" },
        xl: { name: "xl", width: "1280" },
        lg: { name: "lg", width: "1024" },
        md: { name: "md", width: "768" },
        sm: { name: "sm", width: "640" },
        base: { name: "base", width: "0", isMain: true },
      }),
    );
    expect(result.breakpoints.map((b) => [b.key, b.direction, b.width])).toEqual([
      ["sm", "min", 640],
      ["md", "min", 768],
      ["lg", "min", 1024],
      ["xl", "min", 1280],
      ["2xl", "min", 1536],
      ["base", "none", 0],
    ]);
    expect(result.media).not.toHaveProperty("--");
    expect(result.media["--md"]).toBe("(min-width: 768px)");
    expect(codesOf(entries)).not.toContain("option.malformed");
    expect(buildSiteStyleCSS({ ".c": { "@--md": { color: "red" } } }, result.media, (v) => v)).toBe(
      "@media (min-width: 768px) { .c { color: red } }",
    );
  });

  test("a main flag may be a string, and widths may carry spaces", () => {
    const { result } = read(
      bpTable({ lg: { width: " 1366 ", isMain: "true" }, md: { width: "992 " } }),
    );
    expect(result.breakpoints.map((b) => [b.key, b.width, b.isMain])).toEqual([
      ["lg", 1366, true],
      ["md", 992, false],
    ]);
  });

  test("with no list, the legacy two-number option is read the way Cwicly's migration reads it", () => {
    const both = read(table({ cwicly_breakpoints: php({ md: 800, sm: 480 }) }));
    expect(both.result.media).toEqual({
      "--": "1366px",
      "--md": "(max-width: 800px)",
      "--sm": "(max-width: 480px)",
    });
    const defaults = withCode(both.entries, "option.default");
    expect(defaults).toHaveLength(1);
    expect(defaults[0]).toMatchObject({ severity: "info", where: `option:${BP_LIST}` });
    expect(defaults[0]?.message).toContain("legacy");

    const onlyMd = read(table({ cwicly_breakpoints: '{"md":800}' }));
    expect(onlyMd.result.breakpoints.map((b) => b.width)).toEqual([1366, 800, 576]);
    const onlySm = read(table({ cwicly_breakpoints: '{"sm":400}' }));
    expect(onlySm.result.breakpoints.map((b) => b.width)).toEqual([1366, 992, 400]);

    // Cwicly honours md and sm only.
    const extra = read(table({ cwicly_breakpoints: php({ md: 800, sm: 480, xs: 300 }) }));
    expect(extra.result.breakpoints.map((b) => b.key)).toEqual(["lg", "md", "sm"]);

    // An empty array is unset to PHP, so it is not a damaged value.
    const empty = read(table({ cwicly_breakpoints: "a:0:{}" }));
    expect(codesOf(empty.entries)).not.toContain("option.malformed");
    expect(empty.result.breakpoints.map((b) => b.width)).toEqual([1366, 992, 576]);
  });

  test("with neither option, Cwicly's defaults apply and the report says so", () => {
    const { result, entries } = read(new Map());
    expect(result.media).toEqual({
      "--": "1366px",
      "--md": "(max-width: 992px)",
      "--sm": "(max-width: 576px)",
    });
    const defaults = withCode(entries, "option.default");
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.message).toContain("is not set");
    expect(withCode(entries, "option.malformed")).toHaveLength(0);
  });

  test("a list that cannot be used is reported malformed, then falls back to the legacy option, then to the defaults", () => {
    for (const bad of [
      "not json",
      '{"lg":',
      "[]",
      "{}",
      '{"lg":{"width":"abc","isMain":true}}',
      "42",
      '"text"',
    ]) {
      const { result, entries } = read(table({ [BP_LIST]: bad }));
      expect(
        result.breakpoints.map((b) => b.width),
        bad,
      ).toEqual([1366, 992, 576]);
      expect(withCode(entries, "option.malformed").length, bad).toBeGreaterThan(0);
      expect(withCode(entries, "option.default")[0]?.message, bad).toContain("is not usable");
    }
    const viaLegacy = read(
      table({ [BP_LIST]: "{", cwicly_breakpoints: php({ md: 700, sm: 400 }) }),
    );
    expect(viaLegacy.result.breakpoints.map((b) => b.width)).toEqual([1366, 700, 400]);
    expect(
      codesOf(viaLegacy.entries)
        .filter((c) => c !== "option.missing")
        .sort(),
    ).toEqual(["option.default", "option.malformed"]);
  });

  test("a legacy option with neither md nor sm is reported and ignored", () => {
    const { result, entries } = read(table({ cwicly_breakpoints: php({ xs: 300 }) }));
    expect(result.breakpoints.map((b) => b.width)).toEqual([1366, 992, 576]);
    expect(withCode(entries, "option.malformed")[0]?.where).toBe("option:cwicly_breakpoints");
  });

  test("breakpoints with no usable width are skipped one by one", () => {
    const { result, entries } = read(
      bpTable({
        lg: { width: 1366, isMain: true },
        md: { width: "wide" },
        tiny: { width: 0 },
        neg: { width: -5 },
        odd: "not an object",
        sm: { width: 576 },
      }),
    );
    expect(result.breakpoints.map((b) => b.key)).toEqual(["lg", "sm"]);
    const [entry] = withCode(entries, "option.malformed");
    expect(entry?.message).toContain('"md"');
    expect(entry?.message).toContain('"tiny"');
    expect(entry?.message).toContain('"neg"');
    expect(entry?.message).toContain('"odd"');
  });

  test("several main flags: the last wins, as in Cwicly's loop; none: lg, else the widest", () => {
    const several = read(
      bpTable({
        xl: { width: 1920, isMain: true },
        lg: { width: 1366, isMain: true },
        md: { width: 992 },
      }),
    );
    expect(several.result.breakpoints.find((b) => b.isMain)?.key).toBe("lg");
    expect(several.result.breakpoints.map((b) => b.direction)).toEqual(["min", "none", "max"]);
    expect(withCode(several.entries, "option.malformed")[0]?.message).toContain(
      "several breakpoints",
    );

    const noFlagLg = read(bpTable({ md: { width: 992 }, lg: { width: 1366 }, sm: { width: 576 } }));
    expect(noFlagLg.result.breakpoints.find((b) => b.isMain)?.key).toBe("lg");
    expect(withCode(noFlagLg.entries, "option.malformed")[0]?.message).toContain(
      "flags no breakpoint as main",
    );

    const noFlag = read(
      bpTable({ tablet: { width: 992 }, desktop: { width: 1440 }, phone: { width: 480 } }),
    );
    expect(noFlag.result.breakpoints.find((b) => b.isMain)?.key).toBe("desktop");
    expect(noFlag.result.breakpoints.filter((b) => b.isMain)).toHaveLength(1);
  });

  test("with no flag, `lg` is the main breakpoint even when another is wider; the widest is only the last resort", () => {
    // Cwicly's own default is `lg`. Where `lg` is also the widest the two rules agree, which is
    // all the test above can say.
    const wider = read(bpTable({ md: { width: 992 }, lg: { width: 1024 }, xl: { width: 1440 } }));
    expect(wider.result.breakpoints.map((b) => [b.key, b.direction])).toEqual([
      ["md", "min"],
      ["lg", "none"],
      ["xl", "max"],
    ]);
    expect(withCode(wider.entries, "option.malformed")[0]?.message).toContain('using "lg"');
    const noLg = read(bpTable({ md: { width: 992 }, xl: { width: 1440 } }));
    expect(noLg.result.breakpoints.find((b) => b.isMain)?.key).toBe("xl");
  });

  test("the main flag is read the way the stored value spells it, not only as a boolean", () => {
    // `lg` is the fallback for an unflagged list, so a flag on another breakpoint that is honoured
    // shows as that breakpoint being main.
    for (const flag of [true, "true", 1, "1"]) {
      const { result, entries } = read(
        bpTable({ md: { width: 992 }, xl: { width: 1440, isMain: flag }, lg: { width: 1024 } }),
      );
      expect(result.breakpoints.find((b) => b.isMain)?.key, String(flag)).toBe("xl");
      expect(withCode(entries, "option.malformed"), String(flag)).toEqual([]);
    }
    // Cwicly tests the flag by PHP truthiness; these are the spellings of "off" it agrees on.
    for (const flag of [false, 0, "", null]) {
      const { result } = read(
        bpTable({ md: { width: 992 }, xl: { width: 1440, isMain: flag }, lg: { width: 1024 } }),
      );
      expect(result.breakpoints.find((b) => b.isMain)?.key, String(flag)).toBe("lg");
    }
  });

  test("breakpoints come back in cascade order, not stored order, and `direction` keeps the stored side", () => {
    // `CwiclyOptions.breakpoints` in src/types.ts says "in stored order"; this module returns the
    // order `cc_make_global_css()` writes the queries in, which is the one `media` has to follow.
    const stored = {
      "2xl": { width: 2200 },
      xl: { width: 1920 },
      lg: { width: 1366, isMain: true },
      md: { width: 992 },
      sm: { width: 576 },
    };
    const { result } = read(bpTable(stored));
    expect(Object.keys(stored)).toEqual(["2xl", "xl", "lg", "md", "sm"]);
    expect(result.breakpoints.map((b) => [b.key, b.direction])).toEqual([
      ["xl", "min"],
      ["2xl", "min"],
      ["lg", "none"],
      ["md", "max"],
      ["sm", "max"],
    ]);
    expect(Object.keys(result.media)).toEqual(["--xl", "--2xl", "--", "--md", "--sm"]);
  });

  test("a breakpoint key that cannot be a $media name is reported but kept", () => {
    const { result, entries } = read(
      bpTable({ lg: { width: 1366, isMain: true }, "Extra Large": { width: 1900 } }),
    );
    expect(result.breakpoints.map((b) => b.key)).toContain("Extra Large");
    expect(withCode(entries, "option.malformed")[0]?.message).toContain("not a valid $media name");
  });

  test("hyphens, underscores and digits are fine in a breakpoint key, and make a $media name as they are", () => {
    const { result, entries } = read(
      bpTable({
        lg: { width: 1366, isMain: true },
        "tablet-wide_2": { width: 1100 },
        "2xl": { width: 2200 },
      }),
    );
    expect(withCode(entries, "option.malformed")).toEqual([]);
    expect(result.media["--tablet-wide_2"]).toBe("(max-width: 1100px)");
    expect(result.media["--2xl"]).toBe("(max-width: 2200px)");
  });

  test("a single breakpoint is the main one", () => {
    const { result } = read(bpTable({ only: { width: 1200 } }));
    expect(result.breakpoints).toEqual([
      { key: "only", width: 1200, isMain: true, direction: "none" },
    ]);
    expect(result.media).toEqual({ "--": "1200px" });
  });
});

// ── Palette ──────────────────────────────────────────────────────────────────────────────────────

describe("the palette", () => {
  const EXPECTED_COLORS: Record<Site, number> = { fineline: 22, ap: 6 };

  for (const site of SITES) {
    test(`${site}: ${EXPECTED_COLORS[site]} colours, in stored order, with the custom property spelled out`, () => {
      const raw = rawJson(site, "cwicly_global_styles");
      const stored: { id: string; name: string; color: string; variable: string }[] =
        raw.styles[raw.activeStyle].colors;
      const { colors } = real[site].result.globalStyles;
      expect(colors).toHaveLength(EXPECTED_COLORS[site]);
      expect(colors).toEqual(
        stored.map((c) => ({
          id: c.id,
          name: c.name,
          value: c.color,
          variable: `--${c.variable}`,
        })),
      );
      expect([...real[site].result.globalStyles.colorsById.keys()]).toEqual(
        stored.map((c) => c.id),
      );
      expect(real[site].result.globalStyles.activeStyle).toBe(raw.activeStyle);
      expect(real[site].result.globalStyles.activeStyleName).toBe(raw.styles[raw.activeStyle].name);
    });

    test(`${site}: each colour is declared by the compiled global CSS the page serves, in the same order`, () => {
      const declared = [
        ...real[site].result.compiledCss.global.matchAll(
          /(--(?:cc-color|color)-[A-Za-z0-9]+):(#[0-9a-fA-F]{3,8});/g,
        ),
      ]
        .filter((m) => m[1] !== "--cc-color-background")
        .map((m) => [m[1]!, m[2]!.toLowerCase()]);
      expect(
        real[site].result.globalStyles.colors.map((c) => [c.variable, c.value.toLowerCase()]),
      ).toEqual(declared);
    });

    test(`${site}: !var=<id> in global classes resolves to the variable Cwicly's own CSS used`, () => {
      // Cwicly's generator wrote `color:var(--cc-color-6)` for `fontTextColor: {lg: "!var=2hwow!"}`:
      // whatever it did for a (class, property, id) triple, the palette lookup must agree.
      const PROPS: Record<string, string> = {
        backgroundColor: "background-color",
        fontTextColor: "color",
        borderColor: "border-color",
      };
      const rules = [
        ...readFixtureText(site, "css/cc-global-classes.css").matchAll(/([^{}]+)\{([^{}]*)\}/g),
      ].map((m) => ({ selector: m[1]!, body: m[2]!.replace(/\s+/g, "") }));
      const { colorsById } = real[site].result.globalStyles;
      let checked = 0;
      for (const [id, attrs] of real[site].result.globalClassAttrs) {
        const className = real[site].result.globalClassNames.get(id)!;
        const own = new RegExp(`\\.${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
        for (const [attr, property] of Object.entries(PROPS)) {
          const value = (attrs[attr] as { lg?: unknown } | undefined)?.lg;
          if (typeof value !== "string" || !/^!var=[A-Za-z0-9]+!$/.test(value)) continue;
          const { text, unresolved } = resolvePaletteRefs(value, colorsById);
          if (unresolved.length > 0) continue;
          checked++;
          const wanted = `${property}:${text}`;
          expect(
            rules.some((r) => own.test(r.selector) && r.body.includes(wanted)),
            `${className}.${attr} ${value} -> ${wanted}`,
          ).toBe(true);
        }
      }
      expect(checked).toBeGreaterThan(4);
    });
  }

  test("core blocks name palette colours by the variable-named slug; every slug both sites use resolves to the variable of the same name, and the live site styles none of them", () => {
    let seen = 0;
    for (const site of SITES) {
      const { colorsBySlug, colorsByLegacySlug } = real[site].result.globalStyles;
      const css = real[site].result.compiledCss.global;
      const posts = readFixtureJson<{ post_content: string }[]>(site, "rows/posts.json");
      const walk = (blocks: ReturnType<typeof parse>) => {
        for (const block of blocks) {
          if (block.blockName?.startsWith("core/")) {
            for (const [name, value] of Object.entries(block.attrs ?? {})) {
              if (typeof value !== "string" || !value.startsWith("cc-")) continue;
              seen++;
              const color = colorsByLegacySlug.get(value);
              expect(color, `${site} ${name}=${value}`).toBeDefined();
              expect(color?.variable).toBe(`--${value}`);
              // Cwicly registers `cc-<id>` and nothing else as a Gutenberg palette slug, and its
              // generated CSS has `.has-<slug>-color` classes for exactly those: a block that names
              // the variable instead gets a class nothing on the live site styles.
              expect(colorsBySlug.has(value), `${site} ${name}=${value}`).toBe(false);
              expect(css, `${site} ${value}`).not.toContain(`.has-${value}-color{`);
              expect(css, `${site} ${value}`).not.toContain(`.has-${value}-background-color{`);
            }
          }
          walk(block.innerBlocks);
        }
      };
      for (const post of posts) walk(parse(post.post_content ?? ""));
    }
    // textColor and backgroundColor of core blocks: 18 on fineline, 3 on ap.
    expect(seen).toBe(21);
  });

  test("a palette slug is cc-<id> on the live site; the variable-named alias is kept apart, and the two never merge", () => {
    const colors = [
      { id: "aaaaa", name: "A", color: "#111", variable: "cc-color-1" },
      { id: "color-1", name: "B", color: "#222", variable: "other" },
    ];
    const { result } = read(
      table({
        cwicly_global_styles: JSON.stringify({
          activeStyle: "style1",
          styles: { style1: { colors } },
        }),
      }),
    );
    const { colorsBySlug, colorsByLegacySlug } = result.globalStyles;
    // Registered slugs: `cc-` plus the id. `cc-color-1` is B's, because B's id is `color-1`.
    expect([...colorsBySlug.keys()]).toEqual(["cc-aaaaa", "cc-color-1"]);
    expect(colorsBySlug.get("cc-aaaaa")?.name).toBe("A");
    expect(colorsBySlug.get("cc-color-1")?.name).toBe("B");
    expect(colorsBySlug.get("other")).toBeUndefined();
    expect(colorsBySlug.get("cc-color-9")).toBeUndefined();
    // The same string means A to a block that names the variable.
    expect([...colorsByLegacySlug.keys()]).toEqual(["cc-color-1", "other"]);
    expect(colorsByLegacySlug.get("cc-color-1")?.name).toBe("A");
    expect(colorsByLegacySlug.get("other")?.name).toBe("B");
    expect(colorsByLegacySlug.get("cc-aaaaa")).toBeUndefined();
  });

  for (const site of SITES) {
    test(`${site}: the slugs Cwicly registers are cc-<id>, and each has its utility classes in the compiled global CSS`, () => {
      const { colors, colorsBySlug } = real[site].result.globalStyles;
      expect([...colorsBySlug.keys()]).toEqual(colors.map((c) => `cc-${c.id}`));
      // WordPress kebab-cases a slug into its class name, splitting at digit/letter boundaries
      // (`cc-xew3h` is `has-cc-xew-3-h-color`); that is the form a class token carries.
      const kebab = (s: string) =>
        s.replace(/([a-z])(\d)/g, "$1-$2").replace(/(\d)([a-z])/g, "$1-$2");
      const css = real[site].result.compiledCss.global;
      for (const slug of colorsBySlug.keys()) {
        expect(css, `${site} ${slug}`).toContain(`.has-${kebab(slug)}-color{`);
        expect(css, `${site} ${slug}`).toContain(`.has-${kebab(slug)}-background-color{`);
      }
      // …and the variable-named aliases, the other half of what this module can map a name to, have none.
      for (const slug of real[site].result.globalStyles.colorsByLegacySlug.keys()) {
        expect(css, `${site} ${slug}`).not.toContain(`.has-${kebab(slug)}-color{`);
      }
    });
  }

  test("fineline: six unnamed colours, one repeated name and three repeated values are reported as info", () => {
    const { entries } = real.fineline;
    const unnamed = withCode(entries, "option.color-unnamed");
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0]).toMatchObject({ severity: "info", where: "option:cwicly_global_styles" });
    expect(unnamed[0]?.data).toEqual({
      ids: ["ruaij", "q77fs", "gqbir", "4xspr", "ieqd6", "sowfg"],
    });

    const duplicates = withCode(entries, "option.color-duplicate");
    expect(duplicates.map((d) => d.severity)).toEqual(["info", "info", "info", "info"]);
    expect(duplicates.map((d) => d.data)).toEqual([
      { name: "red", ids: ["xew3h", "kbvn1"] },
      { value: "#f9e6e6", ids: ["ug5qp", "ruaij"] },
      { value: "#f0f0f0", ids: ["c8wft", "ieqd6"] },
      { value: "#fafbfc", ids: ["2hwow", "7swv3"] },
    ]);
  });

  test("palette duplicates are found regardless of case and surrounding space", () => {
    const colors = [
      { id: "a1", name: "Brand", color: "#ABCDEF", variable: "cc-color-1" },
      { id: "a2", name: " brand ", color: "#abcdef ", variable: "cc-color-2" },
      { id: "a3", name: "Other", color: "#123456", variable: "cc-color-3" },
    ];
    const raw = JSON.stringify({ activeStyle: "style1", styles: { style1: { colors } } });
    const { entries } = read(table({ cwicly_global_styles: raw }));
    const dups = withCode(entries, "option.color-duplicate");
    expect(dups.map((d) => d.data)).toEqual([
      { name: "brand", ids: ["a1", "a2"] },
      { value: "#abcdef", ids: ["a1", "a2"] },
    ]);
  });

  test("ap has a clean palette", () => {
    const codes = codesOf(real.ap.entries);
    expect(codes).not.toContain("option.color-unnamed");
    expect(codes).not.toContain("option.color-duplicate");
  });

  test("the background colour is the one the compiled CSS declares", () => {
    expect(real.fineline.result.globalStyles.backgroundColor).toBe("#ffffff");
    expect(real.fineline.result.compiledCss.global).toContain("--cc-color-background:#ffffff");
    expect(real.ap.result.globalStyles.backgroundColor).toBeUndefined();
    expect(real.ap.result.compiledCss.global).not.toContain("--cc-color-background");
  });

  test("a variable that already carries its dashes is not doubled; colours may arrive as an object", () => {
    const styles = {
      activeStyle: "style1",
      styles: {
        style1: {
          name: "Main",
          colors: {
            a: { id: "aaaaa", name: "A", color: "#111", variable: "--cc-color-1" },
            b: { id: "bbbbb", name: "B", value: "#222", variable: "cc-color-2" },
          },
        },
      },
    };
    const { result, entries } = read(table({ cwicly_global_styles: JSON.stringify(styles) }));
    expect(result.globalStyles.colors).toEqual([
      { id: "aaaaa", name: "A", value: "#111", variable: "--cc-color-1" },
      { id: "bbbbb", name: "B", value: "#222", variable: "--cc-color-2" },
    ]);
    expect(withCode(entries, "option.malformed")).toHaveLength(0);
  });

  test("an empty `colors` is `{}` in JSON and `a:0:{}` in PHP; both mean none, silently", () => {
    for (const colors of ["{}", "[]"]) {
      const raw = `{"activeStyle":"style1","styles":{"style1":{"name":"S","colors":${colors}}}}`;
      const { result, entries } = read(table({ cwicly_global_styles: raw }));
      expect(result.globalStyles.colors).toEqual([]);
      expect(withCode(entries, "option.malformed")).toHaveLength(0);
    }
    const viaPhp = read(
      table({
        cwicly_global_styles: php({
          activeStyle: "style1",
          styles: { style1: { name: "S", colors: [] } },
        }),
      }),
    );
    expect(viaPhp.result.globalStyles.activeStyleName).toBe("S");
    expect(withCode(viaPhp.entries, "option.malformed")).toHaveLength(0);
  });

  test("a colour missing its id, value or variable is skipped and reported; a repeated id or variable is reported", () => {
    const styles = {
      activeStyle: "style1",
      styles: {
        style1: {
          colors: [
            { id: "ok1", name: "One", color: "#111", variable: "cc-color-1" },
            { name: "No id", color: "#222", variable: "cc-color-2" },
            { id: "ok3", name: "No value", variable: "cc-color-3" },
            { id: "ok4", name: "No variable", color: "#444" },
            "not an object",
            { id: "ok1", name: "Same id", color: "#555", variable: "cc-color-5" },
            { id: "ok6", name: "Same variable", color: "#666", variable: "cc-color-5" },
          ],
        },
      },
    };
    const { result, entries } = read(table({ cwicly_global_styles: JSON.stringify(styles) }));
    expect(result.globalStyles.colors.map((c) => c.id)).toEqual(["ok1", "ok1", "ok6"]);
    const malformed = withCode(entries, "option.malformed").map((e) => e.message);
    expect(malformed.filter((m) => m.includes("without"))).toHaveLength(4);
    expect(malformed.some((m) => m.includes("2 palette colours with the id ok1"))).toBe(true);
    expect(malformed.some((m) => m.includes("share --cc-color-5"))).toBe(true);
    // The CSS cascade lets the later declaration win, and so does the lookup.
    expect(result.globalStyles.colorsById.get("ok1")?.name).toBe("Same id");
  });

  test("an activeStyle that does not exist falls back to style1; no styles at all is reported", () => {
    const styles = (activeStyle: string | undefined) =>
      JSON.stringify({
        ...(activeStyle ? { activeStyle } : {}),
        styles: {
          style1: { name: "One", colors: [{ id: "a", name: "A", color: "#1", variable: "c-1" }] },
          style2: { name: "Two", colors: [] },
        },
      });
    const missing = read(table({ cwicly_global_styles: styles("style9") }));
    expect(missing.result.globalStyles.activeStyle).toBe("style1");
    expect(missing.result.globalStyles.colors).toHaveLength(1);
    expect(withCode(missing.entries, "option.malformed")[0]?.message).toContain(
      '"style9", which does not exist',
    );

    const unnamed = read(table({ cwicly_global_styles: styles(undefined) }));
    expect(withCode(unnamed.entries, "option.malformed")[0]?.message).toContain(
      "does not name an active style",
    );

    const second = read(
      table({
        cwicly_global_styles: JSON.stringify({
          activeStyle: "style2",
          styles: { style2: { name: "Two" } },
        }),
      }),
    );
    expect(second.result.globalStyles.activeStyleName).toBe("Two");

    const none = read(table({ cwicly_global_styles: '{"activeStyle":"style1","styles":"nope"}' }));
    expect(none.result.globalStyles.colors).toEqual([]);
    expect(withCode(none.entries, "option.malformed")[0]?.message).toContain("no styles object");
  });

  test("a missing activeStyle falls back to style1 wherever it is listed, and only without one to the first usable style", () => {
    const one = { name: "One", colors: [{ id: "a", name: "A", color: "#111", variable: "c-1" }] };
    const listedLast = read(
      table({
        cwicly_global_styles: JSON.stringify({
          activeStyle: "style9",
          styles: { style2: { name: "Two" }, style1: one },
        }),
      }),
    );
    expect(listedLast.result.globalStyles.activeStyle).toBe("style1");
    expect(listedLast.result.globalStyles.activeStyleName).toBe("One");
    const noStyle1 = read(
      table({
        cwicly_global_styles: JSON.stringify({
          styles: { junk: 5, style3: { name: "Three" }, style2: { name: "Two" } },
        }),
      }),
    );
    expect(noStyle1.result.globalStyles.activeStyle).toBe("style3");
  });

  test("a number where the editor stores text is read as its text", () => {
    const { result } = read(
      table({
        cwicly_global_styles: JSON.stringify({
          activeStyle: "style1",
          styles: { style1: { colors: [{ id: 12345, name: 7, color: "#111", variable: "c-1" }] } },
        }),
        cwicly_global_classes: JSON.stringify({ k: { attributes: { classID: 42 } } }),
      }),
    );
    expect(result.globalStyles.colors).toEqual([
      { id: "12345", name: "7", value: "#111", variable: "--c-1" },
    ]);
    expect(result.globalClassNames.get("k")).toBe("42");
  });

  test("styles that are none of them objects leave nothing to read, and say so", () => {
    const { result, entries } = read(
      table({
        cwicly_global_styles: '{"activeStyle":"style1","styles":{"style1":5,"style2":"x"}}',
      }),
    );
    expect(result.globalStyles.colors).toEqual([]);
    expect(withCode(entries, "option.malformed")[0]?.message).toContain("has no usable style");
  });

  test("`{}` is a site with no global styles, which is not an error; junk is", () => {
    const empty = read(table({ cwicly_global_styles: "{}" }));
    expect(empty.result.globalStyles.colors).toEqual([]);
    expect(withCode(empty.entries, "option.malformed")).toHaveLength(0);
    for (const junk of ["not json", "[1,2]", '{"x":', '"str"']) {
      const { entries, result } = read(table({ cwicly_global_styles: junk }));
      expect(result.globalStyles.colors, junk).toEqual([]);
      expect(withCode(entries, "option.malformed").length, junk).toBeGreaterThan(0);
    }
  });

  test("typography, theme fonts and global elements keep the style's raw values", () => {
    const raw = rawJson(real.fineline.result && "fineline", "cwicly_global_styles").styles.style1;
    const { globalStyles } = real.fineline.result;
    expect(globalStyles.typography.map((t: { name: string }) => t.name)).toEqual([
      "Heading",
      "Paragraph",
    ]);
    expect(globalStyles.typography[0]?.value).toEqual(raw.typography[0].value);
    expect(Object.keys(globalStyles.themeFonts)).toEqual(Object.keys(raw.themeFonts));
    expect(globalStyles.themeFonts.h1Typography?.size).toEqual({
      lg: "3.2em",
      sm: "2em",
      md: "2.8em",
    });
    expect(globalStyles.themeElements).toEqual(raw.themeElements);
    expect(globalStyles.globalElements.map((e) => e.tag)).toEqual(
      raw.globalElements.map((e: { tag: string }) => e.tag),
    );
    expect(globalStyles.globalElements.find((e) => e.tag === "a")?.value.fontTextColor).toEqual({
      lgactive: "",
      lgfocus: "",
      lgbefore: "",
      lgafter: "",
      lg: "!var=xew3h!",
    });
  });

  test("ap's button and input elements compile to the selectors the global CSS uses", () => {
    const selectors = real.ap.result.globalStyles.globalElements.map((e) => e.selector);
    expect(selectors).toEqual([
      "body",
      "a",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "p",
      "button.ff-btn",
      "input.give-input",
      "input.ff-el-form-control",
    ]);
    for (const selector of selectors.filter((s) => s.includes("."))) {
      expect(real.ap.result.compiledCss.global).toContain(`${selector}{`);
    }
  });

  test("null members of a style are unset fields, not damaged ones", () => {
    const style = {
      name: "S",
      colors: null,
      themeFonts: null,
      typography: null,
      themeElements: null,
      globalElements: null,
      backgroundColor: null,
    };
    const { result, entries } = read(
      table({
        cwicly_global_styles: JSON.stringify({ activeStyle: "style1", styles: { style1: style } }),
      }),
    );
    expect(result.globalStyles).toMatchObject({
      colors: [],
      typography: [],
      themeFonts: {},
      themeElements: {},
      globalElements: [],
      backgroundColor: undefined,
    });
    expect(withCode(entries, "option.malformed")).toEqual([]);
  });

  test("members of the wrong kind are reported by name and ignored", () => {
    const style = {
      name: "S",
      colors: "x",
      themeFonts: "x",
      typography: 5,
      themeElements: [1],
      globalElements: "y",
      typographyExtra: {},
    };
    const { entries } = read(
      table({
        cwicly_global_styles: JSON.stringify({ activeStyle: "style1", styles: { style1: style } }),
      }),
    );
    const messages = withCode(entries, "option.malformed").map((e) => e.message);
    expect(messages.some((m) => m.includes("colors entry that is not a list"))).toBe(true);
    expect(messages.some((m) => m.includes("themeFonts entry that is not an object"))).toBe(true);
    expect(messages.some((m) => m.includes("typography entry that is not a list"))).toBe(true);
    expect(messages.some((m) => m.includes("themeElements entry that is not an object"))).toBe(
      true,
    );
    expect(messages.some((m) => m.includes("globalElements entry that is not a list"))).toBe(true);
  });

  test("a typography preset without a value is skipped and reported", () => {
    const style = {
      typography: [{ name: "Heading" }, { name: "Paragraph", value: { size: { lg: "16px" } } }],
    };
    const { result, entries } = read(
      table({
        cwicly_global_styles: JSON.stringify({ activeStyle: "style1", styles: { style1: style } }),
      }),
    );
    expect(result.globalStyles.typography.map((t) => t.name)).toEqual(["Paragraph"]);
    expect(withCode(entries, "option.malformed")[0]?.message).toContain(
      "typography preset without a value",
    );
  });

  test("a colour named with only spaces is unnamed", () => {
    const colors = [
      { id: "a1", name: "   ", color: "#111", variable: "c-1" },
      { id: "a2", name: "Named", color: "#222", variable: "c-2" },
    ];
    const { entries } = read(
      table({
        cwicly_global_styles: JSON.stringify({
          activeStyle: "style1",
          styles: { style1: { colors } },
        }),
      }),
    );
    expect(withCode(entries, "option.color-unnamed")[0]?.data).toEqual({ ids: ["a1"] });
    expect(withCode(entries, "option.color-unnamed")[0]?.message).toStartWith(
      "1 of 2 palette colours has no name",
    );
  });

  test("a global element without a tag is skipped and reported", () => {
    const styles = {
      activeStyle: "style1",
      styles: {
        style1: {
          globalElements: [
            { name: "x", value: {} },
            { tag: "h1", id: "i", value: { fontSize: { lg: "2em" } } },
          ],
        },
      },
    };
    const { result, entries } = read(table({ cwicly_global_styles: JSON.stringify(styles) }));
    expect(result.globalStyles.globalElements.map((e) => e.tag)).toEqual(["h1"]);
    expect(withCode(entries, "option.malformed")[0]?.message).toContain("without a tag");
  });
});

describe("the palette of a style other than style1", () => {
  // The editor keeps the palette in style1 whatever style is active, and the plugin registers
  // `styles.style1.colors` as the Gutenberg palette. A later style's `colors` is a map of per-colour
  // overrides keyed by colour id (`{}` until one is set), which the editor's CSS generator applies as
  // `styles[active].colors[<id>].color || <style1's colour>.color`. Everything else (typography,
  // fonts, elements, gradients, background) is the active style's own.
  const fineline = () => rawJson("fineline", "cwicly_global_styles");
  const withStyles = (styles: unknown) => {
    const options = new Map(optionsOf("fineline"));
    options.set("cwicly_global_styles", JSON.stringify(styles));
    return read(options);
  };
  const brand = { id: "aaaaa", name: "Brand", color: "#111111", variable: "cc-color-1" };
  const accent = { id: "bbbbb", name: "Accent", color: "#222222", variable: "cc-color-2" };

  test("fineline's own options, with only the active style changed, still have all 22 colours", () => {
    const raw = fineline();
    expect(raw.styles.style2.colors).toEqual({});
    const { result, entries } = withStyles({ ...raw, activeStyle: "style2" });
    const style1 = real.fineline.result.globalStyles;
    expect(result.globalStyles.activeStyle).toBe("style2");
    expect(result.globalStyles.activeStyleName).toBe("Style 2");
    expect(result.globalStyles.colors).toHaveLength(22);
    expect(result.globalStyles.colors).toEqual(style1.colors);
    expect([...result.globalStyles.colorsById.keys()]).toEqual([...style1.colorsById.keys()]);
    expect(withCode(entries, "option.color-unresolved")).toEqual([]);
    expect(withCode(entries, "option.malformed")).toEqual([]);
    // Everything that is not the palette is the active style's own.
    expect(result.globalStyles.globalElements).toHaveLength(
      raw.styles.style2.globalElements.length,
    );
    expect(raw.styles.style2.globalElements.length).not.toBe(style1.globalElements.length);
    expect(result.globalStyles.backgroundColor).toBeUndefined();
  });

  test("an override keyed by colour id replaces that colour's value; an empty one, and one for no colour, change nothing", () => {
    const raw = fineline();
    raw.activeStyle = "style2";
    raw.styles.style2.colors = {
      xew3h: { color: "#aa0000" },
      kbvn1: { color: "" },
      nobody: { color: "#123456" },
    };
    const { result, entries } = withStyles(raw);
    const style1 = real.fineline.result.globalStyles.colors;
    const { colors } = result.globalStyles;
    expect(colors.map((c) => c.id)).toEqual(style1.map((c) => c.id));
    expect(colors.find((c) => c.id === "xew3h")).toEqual({
      ...style1.find((c) => c.id === "xew3h")!,
      value: "#aa0000",
    });
    expect(colors.filter((c) => c.id !== "xew3h")).toEqual(style1.filter((c) => c.id !== "xew3h"));
    expect(result.globalStyles.colorsById.get("xew3h")?.value).toBe("#aa0000");
    expect(result.globalStyles.colorsBySlug.get("cc-xew3h")?.value).toBe("#aa0000");
    expect(withCode(entries, "option.malformed")).toEqual([]);
  });

  test("the editor's default structure: a style1 list, and a later style holding overrides by id", () => {
    const { result, entries } = read(
      stylesTable(
        {
          style1: {
            name: "Style 1",
            key: "style1",
            colors: [brand, accent],
            backgroundColor: "#fff",
          },
          style2: {
            name: "Style 2",
            key: "style2",
            colors: { aaaaa: { color: "#999999" } },
            backgroundColor: "#eeeeee",
          },
        },
        "style2",
      ),
    );
    expect(result.globalStyles.colors).toEqual([
      { id: "aaaaa", name: "Brand", value: "#999999", variable: "--cc-color-1" },
      { id: "bbbbb", name: "Accent", value: "#222222", variable: "--cc-color-2" },
    ]);
    expect(result.globalStyles.backgroundColor).toBe("#eeeeee");
    expect(withCode(entries, "option.malformed")).toEqual([]);
  });

  test("duplicates are judged on the values in effect, not on style1's", () => {
    const { entries } = read(
      stylesTable(
        {
          style1: { colors: [brand, accent] },
          style2: { colors: { bbbbb: { color: "#111111" } } },
        },
        "style2",
      ),
    );
    expect(withCode(entries, "option.color-duplicate").map((e) => e.data)).toEqual([
      { value: "#111111", ids: ["aaaaa", "bbbbb"] },
    ]);
  });

  test("a later style that holds a list of colours has no overrides, as the editor reads it, and the report says so", () => {
    const { result, entries } = read(
      stylesTable(
        {
          style1: { colors: [brand] },
          style2: { colors: [{ ...brand, color: "#999999" }] },
        },
        "style2",
      ),
    );
    expect(result.globalStyles.colors.map((c) => c.value)).toEqual(["#111111"]);
    expect(withCode(entries, "option.malformed")[0]?.message).toContain(
      "colors entry that is not an object",
    );
  });

  test("with no style1 there is no palette to override: the active style's own list stands in, and the report says so", () => {
    const { result, entries } = read(
      stylesTable({ style2: { name: "Two", colors: [brand] } }, "style2"),
    );
    expect(result.globalStyles.colors.map((c) => c.id)).toEqual(["aaaaa"]);
    expect(result.globalStyles.activeStyleName).toBe("Two");
    expect(withCode(entries, "option.malformed")).toHaveLength(1);
    expect(withCode(entries, "option.malformed")[0]?.message).toContain("has no style1");
  });

  test("an activeStyle the styles do not have falls back without borrowing another style's overrides", () => {
    const { result } = read(
      stylesTable(
        { style1: { colors: [brand] }, style2: { colors: { aaaaa: { color: "#999999" } } } },
        "style9",
      ),
    );
    expect(result.globalStyles.activeStyle).toBe("style1");
    expect(result.globalStyles.colors.map((c) => c.value)).toEqual(["#111111"]);
  });
});

describe("what a !var=<id>! token can name", () => {
  // The editor's resolver turns `!var=<id>!` into `var(--…)` for three kinds of id: a palette colour,
  // a shade of one (`paletteColors[n]`, which counts only while the colour's `paletteState` is on, and
  // is named by its position in Cwicly's eleven steps) and a dynamic variant (`dynamic.<kind>[n]`,
  // named by the kind's abbreviation and its value, a `.` in the value becoming `-`).
  const brand = {
    id: "abc12",
    name: "Brand",
    color: "#336699",
    variable: "cc-color-1",
    paletteState: true,
    paletteColors: [
      { id: "sh050", color: "#eef" },
      { id: "sh100", color: "#ddf" },
      { id: "sh200", color: "#ccf" },
    ],
    dynamic: {
      lighten: [
        { id: "dyn10", value: 10 },
        { id: "dynblank", value: "" },
      ],
      opacity: [{ id: "dynhalf", value: 0.5 }],
      saturate: [{ id: "dynstr", value: "20" }],
    },
  };
  const hidden = {
    id: "hid99",
    name: "Hidden",
    color: "#000000",
    variable: "cc-color-2",
    paletteState: false,
    paletteColors: [{ id: "unused", color: "#111111" }],
  };
  const palette = (colors: unknown[] = [brand, hidden], more: Record<string, string> = {}) =>
    read(stylesTable({ style1: { colors } }, "style1", more));

  test("colours, their shades and their dynamic variants each resolve to the variable the compiled CSS declares", () => {
    const { result } = palette();
    const { colorRefs, colors, colorsById } = result.globalStyles;
    expect([...colorRefs.values()].map((r) => [r.id, r.kind, r.variable, r.colorId])).toEqual([
      ["abc12", "color", "--cc-color-1", "abc12"],
      ["hid99", "color", "--cc-color-2", "hid99"],
      ["sh050", "shade", "--cc-color-1-50", "abc12"],
      ["sh100", "shade", "--cc-color-1-100", "abc12"],
      ["sh200", "shade", "--cc-color-1-200", "abc12"],
      ["dyn10", "variant", "--cc-color-1-lt-10", "abc12"],
      ["dynhalf", "variant", "--cc-color-1-op-0-5", "abc12"],
      ["dynstr", "variant", "--cc-color-1-sat-20", "abc12"],
    ]);
    // The palette itself is the two colours; shades and variants are only ever named by a token.
    expect(colors.map((c) => c.id)).toEqual(["abc12", "hid99"]);
    expect([...colorsById.keys()]).toEqual(["abc12", "hid99"]);
    expect(
      resolvePaletteRefs(
        "fill:!var=sh100! stroke:!var=dyn10! x:!var=dynhalf! y:!var=abc12!",
        colorRefs,
      ),
    ).toEqual({
      text: "fill:var(--cc-color-1-100) stroke:var(--cc-color-1-lt-10) x:var(--cc-color-1-op-0-5) y:var(--cc-color-1)",
      unresolved: [],
    });
  });

  test("every kind of variant has the abbreviation the editor gives it, and the value's first `.` becomes `-`", () => {
    // The editor's table: `{opacity: "op", lighten: "lt", darken: "dk", saturate: "sat",
    // desaturate: "desat", spin: "sp"}`, and its formatter is `String(value).replace(".", "-")`.
    const kinds = ["opacity", "lighten", "darken", "saturate", "desaturate", "spin"];
    const dynamic = Object.fromEntries(
      kinds.map((kind) => [kind, [{ id: `id-${kind}`, value: 10 }]]),
    );
    const { colorRefs } = palette([
      {
        ...brand,
        dynamic: {
          ...dynamic,
          spin: [
            { id: "id-spin", value: 10 },
            { id: "dot-first", value: "1.5.2" },
          ],
        },
      },
    ]).result.globalStyles;
    expect(kinds.map((kind) => colorRefs.get(`id-${kind}`)?.variable)).toEqual([
      "--cc-color-1-op-10",
      "--cc-color-1-lt-10",
      "--cc-color-1-dk-10",
      "--cc-color-1-sat-10",
      "--cc-color-1-desat-10",
      "--cc-color-1-sp-10",
    ]);
    expect(colorRefs.get("dot-first")?.variable).toBe("--cc-color-1-sp-1-5.2");
  });

  test("a shade of a colour whose palette is off, and a variant with no value, are not ids", () => {
    const { colorRefs } = palette().result.globalStyles;
    expect(colorRefs.has("unused")).toBe(false);
    expect(colorRefs.has("dynblank")).toBe(false);
  });

  test("a colour's own id outranks a shade or variant that repeats it, and the first colour to claim a shade keeps it", () => {
    const { colorRefs } = palette([
      { ...brand, paletteColors: [{ id: "hid99", color: "#fff" }, { id: "shared" }] },
      hidden,
      {
        id: "other",
        variable: "cc-color-3",
        color: "#1",
        paletteState: true,
        paletteColors: [{ id: "shared" }],
      },
    ]).result.globalStyles;
    expect(colorRefs.get("hid99")).toMatchObject({ kind: "color", variable: "--cc-color-2" });
    expect(colorRefs.get("shared")).toMatchObject({ kind: "shade", variable: "--cc-color-1-100" });
  });

  test("a global class that names a shade or a variant resolves; one that names a switched-off shade is reported", () => {
    const classes = {
      c1: {
        attributes: {
          classID: "uses-shade",
          fontTextColor: { lg: "!var=sh100!" },
          backgroundColor: { lg: "!var=dyn10!" },
        },
      },
      c2: { attributes: { classID: "uses-hidden", borderColor: { lg: "!var=unused!" } } },
    };
    const { entries } = palette([brand, hidden], {
      cwicly_global_classes: JSON.stringify(classes),
    });
    expect(withCode(entries, "option.color-unresolved").map((e) => e.data?.classID)).toEqual([
      "uses-hidden",
    ]);
  });

  test("a shade past Cwicly's eleventh step has no name, and a kind of variant it does not know has no abbreviation", () => {
    const { result, entries } = palette([
      {
        ...brand,
        paletteColors: Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, color: "#fff" })),
        dynamic: { tint: [{ id: "tint1", value: 5 }], spin: [{ id: "spin1", value: 30 }] },
      },
    ]);
    const { colorRefs } = result.globalStyles;
    expect(colorRefs.get("s10")?.variable).toBe("--cc-color-1-950");
    expect(colorRefs.has("s11")).toBe(false);
    expect(colorRefs.has("tint1")).toBe(false);
    expect(colorRefs.get("spin1")?.variable).toBe("--cc-color-1-sp-30");
    const malformed = withCode(entries, "option.malformed").map((e) => e.message);
    expect(malformed).toHaveLength(2);
    expect(malformed.some((m) => m.includes("beyond"))).toBe(true);
    expect(malformed.some((m) => m.includes('"tint"'))).toBe(true);
  });

  test("the real palettes have no shades or variants, so their references are exactly their colours", () => {
    for (const site of SITES) {
      const { colorRefs, colorsById } = real[site].result.globalStyles;
      expect([...colorRefs.keys()], site).toEqual([...colorsById.keys()]);
      expect(
        [...colorRefs.values()].every((r) => r.kind === "color"),
        site,
      ).toBe(true);
    }
  });
});

describe("gradients", () => {
  // Abridged from a live site's options (littlecocalico): the stored gradients, the palette colour
  // one of them names, and what the editor wrote for them into `cwicly_global_css`.
  const white = { color: "#ffffff", name: "White", id: "l04l3", variable: "cc-color-5" };
  const gradients = [
    { name: "", color: "linear-gradient(180deg, #6190e8 0%, !var=l04l3! 49%)" },
    { name: "", color: "linear-gradient(180deg, #6190e8 0%, #ffffff 49%)" },
  ];
  const compiled =
    ":root, .dark {--cc-color-5:#ffffff;" +
    "--cc-gradient-1:linear-gradient(180deg, #6190e8 0%, var(--cc-color-5) 49%);" +
    "--cc-gradient-2:linear-gradient(180deg, #6190e8 0%, #ffffff 49%);}";

  test("the active style's gradients are read, numbered as the editor numbers them, and resolve to what it compiled", () => {
    const { result, entries } = read(
      stylesTable({ style1: { colors: [white], gradients } }, "style1", {
        cwicly_global_css: compiled,
      }),
    );
    const { gradients: read1, colorRefs } = result.globalStyles;
    expect(read1).toEqual([
      { name: "", variable: "--cc-gradient-1", value: gradients[0]!.color },
      { name: "", variable: "--cc-gradient-2", value: gradients[1]!.color },
    ]);
    for (const g of read1) {
      const { text, unresolved } = resolvePaletteRefs(g.value, colorRefs);
      expect(unresolved).toEqual([]);
      expect(result.compiledCss.global).toContain(`${g.variable}:${text};`);
    }
    expect(withCode(entries, "option.malformed")).toEqual([]);
    expect(withCode(entries, "option.color-unresolved")).toEqual([]);
  });

  test("gradients are the active style's, not style1's", () => {
    const { result } = read(
      stylesTable(
        {
          style1: { colors: [white], gradients },
          style2: { gradients: [{ name: "Sky", color: "linear-gradient(red, blue)" }] },
        },
        "style2",
      ),
    );
    expect(result.globalStyles.gradients).toEqual([
      { name: "Sky", variable: "--cc-gradient-1", value: "linear-gradient(red, blue)" },
    ]);
  });

  test("an entry with no colour is skipped and reported, and the entries after it keep their numbers", () => {
    const { result, entries } = read(
      stylesTable({
        style1: {
          gradients: [
            { name: "a", color: "red" },
            { name: "b" },
            "text",
            { name: "c", color: "blue" },
          ],
        },
      }),
    );
    expect(result.globalStyles.gradients.map((g) => [g.name, g.variable])).toEqual([
      ["a", "--cc-gradient-1"],
      ["c", "--cc-gradient-4"],
    ]);
    expect(withCode(entries, "option.malformed").map((e) => e.message)).toEqual([
      expect.stringContaining("gradient (#2) without a colour"),
      expect.stringContaining("gradient (#3) without a colour"),
    ]);
  });

  test("a palette colour a gradient names that the palette lacks is reported, like one a global class names", () => {
    const { result, entries } = read(
      stylesTable({
        style1: {
          colors: [white],
          gradients: [{ name: "", color: "linear-gradient(!var=gone1! 0%, !var=l04l3! 50%)" }],
        },
      }),
    );
    expect(result.globalStyles.gradients).toHaveLength(1);
    expect(withCode(entries, "option.color-unresolved")).toMatchObject([
      {
        severity: "warn",
        where: "option:cwicly_global_styles",
        data: { gradient: 1, ids: ["gone1"] },
      },
    ]);
  });

  test("no gradients is the usual case, and says nothing; gradients of the wrong kind are reported", () => {
    for (const site of SITES) {
      expect(real[site].result.globalStyles.gradients, site).toEqual([]);
      expect(real[site].result.compiledCss.global, site).not.toContain("--cc-gradient-");
    }
    for (const none of [undefined, null, [], {}]) {
      const { result, entries } = read(stylesTable({ style1: { gradients: none } }));
      expect(result.globalStyles.gradients).toEqual([]);
      expect(withCode(entries, "option.malformed")).toEqual([]);
    }
    const bad = read(stylesTable({ style1: { gradients: "linear-gradient(red, blue)" } }));
    expect(bad.result.globalStyles.gradients).toEqual([]);
    expect(withCode(bad.entries, "option.malformed")[0]?.message).toContain(
      "gradients entry that is not a list",
    );
  });
});

describe("global elements", () => {
  // The first two are abridged from a third live site's options (riverview), with the CSS Cwicly
  // compiled for them beside. Cwicly's Global Elements panel has five kinds of entry: headings and tags
  // (a `tag`), blocks (a Cwicly `class` such as `cc-cntr`), custom rules (`customRuleBool` and a
  // `customRule`) and tooltips (`isTooltip`).
  const container = {
    name: "Container #1",
    value: {
      name: "Container #1",
      fontLocation: "google",
      containerSizeMaxWidth: { lg: "1400px" },
    },
    tag: null,
    class: "cc-cntr",
    id: "hy1dt",
  };
  const postRule = ".post-type-post .editor-visual-editor p, .single-post .content-post p";
  const paragraphs = {
    name: "Post Paragraphs",
    id: "1dzlppd",
    value: { fontTextColor: { lg: "!var=e7lva!" }, fontHeight: { lg: "2.2rem" } },
    tag: "p",
    class: null,
    additionalClass: "",
    isTooltip: null,
    customRuleBool: true,
    customRule: postRule,
  };
  const compiled = `.cc-cntr{max-width:1400px;}${postRule}{color:var(--color-e7lva);line-height:2.2rem;}`;
  const elementsOf = (globalElements: unknown[], more: Record<string, string> = {}) =>
    read(stylesTable({ style1: { globalElements } }, "style1", more));

  test("a block element (a class, no tag) and a custom-rule element select what Cwicly compiled them to", () => {
    const { result, entries } = elementsOf([container, paragraphs], {
      cwicly_global_css: compiled,
    });
    const elements = result.globalStyles.globalElements;
    expect(elements.map((e) => [e.name, e.selector])).toEqual([
      ["Container #1", ".cc-cntr"],
      ["Post Paragraphs", postRule],
    ]);
    expect(elements[0]).toMatchObject({
      tag: "",
      class: "cc-cntr",
      customRuleBool: false,
      isTooltip: false,
      value: container.value,
    });
    expect(elements[1]).toMatchObject({
      tag: "p",
      class: "",
      customRule: postRule,
      customRuleBool: true,
      isTooltip: false,
    });
    for (const e of elements) expect(result.compiledCss.global, e.name).toContain(`${e.selector}{`);
    expect(withCode(entries, "option.malformed")).toEqual([]);
  });

  const SELECTORS: [label: string, element: Record<string, unknown>, selector: string][] = [
    ["a tag", { tag: "h1" }, "h1"],
    [
      "a tag and an additional class",
      { tag: "button", additionalClass: "ff-btn" },
      "button.ff-btn",
    ],
    [
      "several additional classes join with dots, not spaces (a space would be a descendant selector)",
      { tag: "button", additionalClass: "ff-btn extra" },
      "button.ff-btn.extra",
    ],
    [
      "stray spaces around additional classes are not classes",
      { tag: "button", additionalClass: "  ff-btn   extra " },
      "button.ff-btn.extra",
    ],
    [
      "any whitespace separates additional classes",
      { tag: "button", additionalClass: "ff-btn\textra\nmore" },
      "button.ff-btn.extra.more",
    ],
    [
      "a custom rule that is switched on by a string is one",
      { name: "x", customRuleBool: "true", customRule: ".a > .b" },
      ".a > .b",
    ],
    [
      "a tooltip that is switched on by a number is one",
      { name: "t", isTooltip: 1 },
      '.tippy-box[data-theme~="t"]',
    ],
    ["a block class", { class: "cc-sct" }, ".cc-sct"],
    [
      "a block class and an additional class",
      { class: "cc-btn", additionalClass: "big" },
      ".cc-btn.big",
    ],
    ["an additional class on its own", { additionalClass: "lead" }, ".lead"],
    ["a tag outranks a block class", { tag: "p", class: "cc-sct" }, "p"],
    [
      "a custom rule is used as written, without its :pseudos placeholder and without additional classes",
      {
        tag: "li",
        customRuleBool: true,
        customRule: ".entry ul:pseudos > li",
        additionalClass: "x",
      },
      ".entry ul > li",
    ],
    [
      "a custom rule outranks the tag and the class",
      { tag: "p", class: "cc-sct", customRuleBool: true, customRule: ".a .b" },
      ".a .b",
    ],
    [
      "a tooltip is the tippy box carrying its theme",
      { name: "tip", isTooltip: true },
      '.tippy-box[data-theme~="tip"]',
    ],
    [
      "a tooltip outranks a custom rule",
      { name: "tip", isTooltip: true, customRuleBool: true, customRule: ".a" },
      '.tippy-box[data-theme~="tip"]',
    ],
    ["an input with no types", { tag: "input", additionalClass: "give-input" }, "input.give-input"],
    ["an input with an empty list of types", { tag: "input", value: { type: [] } }, "input"],
    [
      "an input with types is one selector per type, a textarea standing for itself",
      {
        tag: "input",
        value: { type: [{ value: "text" }, { value: "textarea" }, { value: "email" }] },
      },
      'input[type="text"],textarea,input[type="email"]',
    ],
    [
      "an additional class on an input with several types lands on the last selector only, as the editor writes it",
      {
        tag: "input",
        additionalClass: "x",
        value: { type: [{ value: "text" }, { value: "textarea" }] },
      },
      'input[type="text"],textarea.x',
    ],
    [
      "the list of types belongs to inputs only",
      { tag: "select", value: { type: [{ value: "text" }] } },
      "select",
    ],
  ];
  for (const [label, element, selector] of SELECTORS) {
    test(`selector: ${label}`, () => {
      const { result, entries } = elementsOf([{ name: "e", id: "i", value: {}, ...element }]);
      expect(result.globalStyles.globalElements.map((e) => e.selector)).toEqual([selector]);
      expect(withCode(entries, "option.malformed")).toEqual([]);
    });
  }

  test("an element that selects nothing (no tag, class, custom rule or additional class) is skipped and reported, whatever else it holds", () => {
    const { result, entries } = elementsOf([
      { name: "x", value: { fontSize: { lg: "1em" } } },
      { name: "Blank rule", customRuleBool: true, customRule: "   ", value: {} },
      { name: "No rule yet", customRuleBool: true, value: {} },
      "text",
      { tag: "h1", id: "i", value: {} },
    ]);
    expect(result.globalStyles.globalElements.map((e) => e.tag)).toEqual(["h1"]);
    const messages = withCode(entries, "option.malformed").map((e) => e.message);
    expect(messages).toHaveLength(4);
    expect(messages.every((m) => m.includes("without a tag, class or custom rule"))).toBe(true);
    expect(messages[0]).toContain('"x"');
    expect(messages[1]).toContain('"Blank rule"');
    expect(messages[2]).toContain('"No rule yet"');
  });

  test("both sites' elements all select what their compiled global CSS selects, when they have a declaration to compile", () => {
    // `name` and `fontLocation` are the editor's bookkeeping, and `class` and `type` hold an input's
    // extra class and its (here empty) list of types: none of them is a declaration.
    const BOOKKEEPING = new Set(["name", "fontLocation", "class", "type"]);
    const withoutRule: Record<Site, string[]> = { fineline: [], ap: [] };
    for (const site of SITES) {
      const { globalElements } = real[site].result.globalStyles;
      const css = real[site].result.compiledCss.global;
      expect(globalElements.length, site).toBeGreaterThan(8);
      for (const e of globalElements) {
        const declares = Object.keys(e.value).some((key) => !BOOKKEEPING.has(key));
        const compiled = css.includes(`${e.selector}{`);
        expect(compiled, `${site} ${e.name}: ${e.selector}`).toBe(declares);
        if (!compiled) withoutRule[site].push(e.name);
      }
    }
    // The two that have nothing in them: Cwicly wrote no rule, and so none is missing.
    expect(withoutRule).toEqual({ fineline: ["Button #1", "Lists"], ap: [] });
  });
});

describe("resolvePaletteRefs", () => {
  const colors = new Map([
    ["2hwow", { variable: "--cc-color-6" }],
    ["taldn", { variable: "--cc-color-1" }],
  ]);

  test("replaces every token with a var() of the palette's variable", () => {
    expect(resolvePaletteRefs("!var=2hwow!", colors)).toEqual({
      text: "var(--cc-color-6)",
      unresolved: [],
    });
    expect(
      resolvePaletteRefs("linear-gradient(180deg, !var=taldn! 0%, !var=2hwow! 49%)", colors).text,
    ).toBe("linear-gradient(180deg, var(--cc-color-1) 0%, var(--cc-color-6) 49%)");
    expect(resolvePaletteRefs("fill:!var=taldn! !important", colors).text).toBe(
      "fill:var(--cc-color-1) !important",
    );
  });

  test("an id the palette does not have is left as written and listed", () => {
    expect(resolvePaletteRefs("a !var=zvtsr! b !var=2hwow! c !var=zvtsr!", colors)).toEqual({
      text: "a !var=zvtsr! b var(--cc-color-6) c !var=zvtsr!",
      unresolved: ["zvtsr", "zvtsr"],
    });
  });

  test("text without a token is unchanged, and !important is not a token", () => {
    expect(resolvePaletteRefs("color: red !important", colors)).toEqual({
      text: "color: red !important",
      unresolved: [],
    });
    expect(resolvePaletteRefs("", colors)).toEqual({ text: "", unresolved: [] });
  });

  test("it takes the palette as src/types.ts types it, a list of colours, as well as a map by id", () => {
    // `ConvertCtx.cwicly` is a `CwiclyOptions`, whose `globalStyles.colors` is a list and which has
    // no map: a converter holding only that has to be able to resolve a token from it.
    const { colors, colorsById } = real.fineline.result.globalStyles;
    const text = `color: !var=${colors[0]!.id}!; fill: !var=nobody!; border: !var=${colors[3]!.id}!`;
    const expected = {
      text: `color: var(${colors[0]!.variable}); fill: !var=nobody!; border: var(${colors[3]!.variable})`,
      unresolved: ["nobody"],
    };
    expect(resolvePaletteRefs(text, colors)).toEqual(expected);
    expect(resolvePaletteRefs(text, colorsById)).toEqual(expected);
    // A repeated id keeps the last, as the map built from the same list does.
    const twice = [
      { id: "same", variable: "--first" },
      { id: "same", variable: "--second" },
    ];
    expect(resolvePaletteRefs("!var=same!", twice).text).toBe("var(--second)");
    expect(resolvePaletteRefs("!var=same!", []).unresolved).toEqual(["same"]);
  });

  test("an id may hold hyphens and underscores, as the editor's own token pattern allows", () => {
    const ids = new Map([
      ["a-b", { variable: "--one" }],
      ["c_d", { variable: "--two" }],
      ["e-f_g9", { variable: "--three" }],
    ]);
    expect(resolvePaletteRefs("!var=a-b! !var=c_d! !var=e-f_g9!", ids)).toEqual({
      text: "var(--one) var(--two) var(--three)",
      unresolved: [],
    });
  });

  test("it repairs the one palette token left in ap's served stylesheet", () => {
    const css = readFixtureText("ap", "css/cc-global-classes.css");
    const token = css.match(/!var=([A-Za-z0-9]+)!/);
    expect(token?.[1]).toBe("9d4k1");
    // The id is in the active palette (White, --cc-color-5): Cwicly's generator just never resolved
    // it for icon colours, so it is repairable rather than a deleted colour.
    const { text, unresolved } = resolvePaletteRefs(
      token![0],
      real.ap.result.globalStyles.colorsById,
    );
    expect(unresolved).toEqual([]);
    expect(text).toBe("var(--cc-color-5)");
  });
});

// ── Global classes ───────────────────────────────────────────────────────────────────────────────

describe("global classes", () => {
  const EXPECTED: Record<Site, number> = { fineline: 34, ap: 54 };

  for (const site of SITES) {
    test(`${site}: ${EXPECTED[site]} classes; the name and the raw attributes are the stored ones`, () => {
      const stored = rawJson<
        Record<string, { attributes: Record<string, unknown> & { classID: string } }>
      >(site, "cwicly_global_classes");
      const { globalClassNames, globalClassAttrs } = real[site].result;
      expect(Object.keys(stored)).toHaveLength(EXPECTED[site]);
      expect(globalClassNames.size).toBe(EXPECTED[site]);
      expect(globalClassAttrs.size).toBe(EXPECTED[site]);
      expect([...globalClassNames.keys()]).toEqual(Object.keys(stored));
      for (const [id, entry] of Object.entries(stored)) {
        expect(globalClassNames.get(id)).toBe(entry.attributes.classID);
        expect(globalClassAttrs.get(id)).toEqual(entry.attributes);
      }
    });

    test(`${site}: every class the cache holds CSS for is served, and every served root class is known`, () => {
      const served = readFixtureText(site, "css/cc-global-classes.css");
      const { result } = real[site];
      for (const [id, cached] of result.globalClassesRendered) {
        const name = result.globalClassNames.get(id);
        if (!name || !(cached.common || Object.values(cached.responsive).some(Boolean))) continue;
        expect(served, name).toContain(`.${name}`);
      }
      const known = new Set(result.globalClassNames.values());
      postcss.parse(served).walkRules((rule) => {
        for (const selector of rule.selectors) {
          // The leading compound: ap has a global class whose classID is itself `.a.b` (it styles
          // a plugin's element), and others that add a plugin's class to their own.
          const compound = /^(?:[a-z]+)?((?:\.[A-Za-z0-9_-]+)+)/.exec(selector.trim())?.[1];
          if (!compound) continue;
          const first = compound.split(".")[1]!;
          expect(known.has(compound.slice(1)) || known.has(first), selector).toBe(true);
        }
      });
    });
  }

  test("ids that blocks use resolve through the map, across every post of both sites", () => {
    const unresolved: Record<Site, Record<string, number>> = { fineline: {}, ap: {} };
    for (const site of SITES) {
      const posts = readFixtureJson<{ post_content: string }[]>(site, "rows/posts.json");
      const walk = (blocks: ReturnType<typeof parse>) => {
        for (const block of blocks) {
          const used = block.attrs?.globalClass;
          for (const id of Array.isArray(used) ? (used as string[]) : []) {
            if (!real[site].result.globalClassNames.has(id))
              unresolved[site][id] = (unresolved[site][id] ?? 0) + 1;
          }
          walk(block.innerBlocks);
        }
      };
      for (const post of posts) walk(parse(post.post_content ?? ""));
    }
    expect(unresolved.ap).toEqual({});
    // fineline: `icon-white` was deleted and recreated, so 31 blocks on 16 pages still hold its old
    // id. The live site prints no class for an unknown id, and neither can a converter.
    expect(unresolved.fineline).toEqual({ "3yEPq5XEDBJoOaj": 31 });
  });

  test("ap: two classes borrow palette ids from another site's palette, and each is reported once", () => {
    const refs = withCode(real.ap.entries, "option.color-unresolved");
    expect(refs).toHaveLength(2);
    expect(
      refs.every((e) => e.severity === "warn" && e.where === "option:cwicly_global_classes"),
    ).toBe(true);
    expect(refs.map((e) => (e.data as { classID: string }).classID)).toEqual([
      "query-pagination-numbers",
      "query-pagination-default",
    ]);
    const ids = refs.flatMap((e) => (e.data as { refs: { id: string }[] }).refs.map((r) => r.id));
    expect(new Set(ids)).toEqual(new Set(["zvtsr", "49qom", "y9fub"]));
    expect(ids).toHaveLength(4);
    // Found independently: every !var= id in the stored classes that the palette lacks.
    const palette = new Set(real.ap.result.globalStyles.colors.map((c) => c.id));
    const stored = optionsOf("ap").get("cwicly_global_classes")!;
    const missing = [...stored.matchAll(/!var=([A-Za-z0-9]+)!/g)]
      .map((m) => m[1]!)
      .filter((id) => !palette.has(id));
    expect(missing.sort()).toEqual(ids.sort());
  });

  test("fineline's palette references all resolve", () => {
    expect(withCode(real.fineline.entries, "option.color-unresolved")).toHaveLength(0);
  });

  test("a class without a classID gets no name (Cwicly prints no class for it), and is reported", () => {
    const classes = {
      okay: { attributes: { classID: "card" } },
      blank: { attributes: { classID: "  " } },
      none: { attributes: { fontSize: { lg: "2em" } } },
      noAttrs: { primaries: ["div"] },
      scalar: 5,
      fine: { attributes: { classID: "stack", paddingTop: { lg: "1rem" } } },
    };
    const { result, entries } = read(table({ cwicly_global_classes: JSON.stringify(classes) }));
    expect([...result.globalClassNames]).toEqual([
      ["okay", "card"],
      ["fine", "stack"],
    ]);
    expect([...result.globalClassAttrs.keys()]).toEqual(["okay", "fine"]);
    const malformed = withCode(entries, "option.malformed");
    expect(malformed).toHaveLength(4);
    expect(
      malformed
        .filter((e) => e.message.includes("without a classID"))
        .map((e) => (e.data as { id: string }).id),
    ).toEqual(["blank", "none"]);
    expect(
      malformed
        .filter((e) => e.message.includes("without an attributes object"))
        .map((e) => (e.data as { id: string }).id),
    ).toEqual(["noAttrs", "scalar"]);
  });

  test("two classes with one classID are reported (their rules share a selector)", () => {
    const classes = {
      a: { attributes: { classID: "card" } },
      b: { attributes: { classID: "card" } },
      c: { attributes: { classID: "other" } },
    };
    const { result, entries } = read(table({ cwicly_global_classes: JSON.stringify(classes) }));
    expect(result.globalClassNames.size).toBe(3);
    const dup = withCode(entries, "option.class-duplicate");
    expect(dup).toHaveLength(1);
    expect(dup[0]?.message).toContain("share one selector");
    expect(withCode(entries, "option.malformed")).toEqual([]);
    expect(dup[0]).toMatchObject({ severity: "info", data: { classID: "card", ids: ["a", "b"] } });
  });

  test("`{}`, `[]` and a PHP empty array are an empty set of classes, not a fault", () => {
    for (const empty of ["{}", "[]", "a:0:{}"]) {
      const { result, entries } = read(table({ cwicly_global_classes: empty }));
      expect(result.globalClassNames.size, empty).toBe(0);
      expect(withCode(entries, "option.malformed"), empty).toHaveLength(0);
    }
  });

  test("global classes written as PHP-serialised data read the same", () => {
    const classes = {
      id1: { attributes: { classID: "card", paddingTop: { lg: "1rem" } }, primaries: ["div"] },
    };
    const { result } = read(table({ cwicly_global_classes: php(classes) }));
    expect(result.globalClassNames.get("id1")).toBe("card");
    expect(result.globalClassAttrs.get("id1")).toEqual({
      classID: "card",
      paddingTop: { lg: "1rem" },
    });
  });
});

// ── Compiled CSS ─────────────────────────────────────────────────────────────────────────────────

describe("compiled CSS", () => {
  for (const site of SITES) {
    test(`${site}: cwicly_global_css is what every rendered page prints in cc-global-inline-css`, () => {
      const pages = htmlPages(site);
      expect(pages.length).toBeGreaterThan(3);
      for (const { name, html } of pages) {
        const inline = /<style id="cc-global-inline-css">([\s\S]*?)<\/style>/.exec(html)?.[1];
        expect(inline, name).toBeDefined();
        // WordPress appends the source URL comment to an inline style it prints.
        const printed = inline!.replace(/\/\*# sourceURL=cc-global-inline-css \*\/\s*$/, "").trim();
        expect(real[site].result.compiledCss.global, name).toBe(printed);
      }
    });

    test(`${site}: cwicly_global_stylesheets_rendered is the served cc-global-stylesheets.css`, () => {
      expect(real[site].result.compiledCss.stylesheets).toBe(
        readFixtureText(site, "css/cc-global-stylesheets.css"),
      );
    });
  }

  test("all three compiled strings are CSS that the CSS module's parser accepts, on both sites", () => {
    for (const site of SITES) {
      for (const [name, css] of Object.entries(real[site].result.compiledCss)) {
        let rules = 0;
        expect(
          () => postcss.parse(css).walkRules(() => void rules++),
          `${site} ${name}`,
        ).not.toThrow();
        // Only fineline's stylesheet option is empty; everything else carries real rules.
        if (!(site === "fineline" && name === "stylesheets"))
          expect(rules, `${site} ${name}`).toBeGreaterThan(20);

        // And the CSS module itself reads each one under the breakpoints found here: it can parse
        // it, and every media query in it names a breakpoint the list declares.
        const index = parseCwiclyCss(css, real[site].result.breakpoints, { file: name });
        const problems = index.artifacts.filter(
          (a) => a.code === CSS_ARTIFACT.syntaxError || a.code === CSS_ARTIFACT.mediaUnmapped,
        );
        expect(problems, `${site} ${name}`).toEqual([]);
        if (rules > 0)
          expect(index.classes.size + index.other.size, `${site} ${name}`).toBeGreaterThan(0);
      }
    }
  });

  test("the stylesheets option is empty on fineline and holds three compiled sheets on ap", () => {
    expect(real.fineline.result.compiledCss.stylesheets).toBe("");
    expect(real.ap.result.compiledCss.stylesheets.length).toBeGreaterThan(1000);
    expect(real.ap.result.compiledCss.stylesheets).toContain(
      ".block-link{text-decoration:none !important}",
    );
  });

  test("cwicly_global_classes_rendered is a PHP-serialised per-class cache, decoded by class id", () => {
    for (const site of SITES) {
      const stored = optionsOf(site).get("cwicly_global_classes_rendered")!;
      expect(stored.startsWith("a:"), site).toBe(true);
      const declared = Number(/^a:(\d+):/.exec(stored)![1]);
      const { globalClassesRendered } = real[site].result;
      expect(globalClassesRendered.size, site).toBe(declared);
      for (const entry of globalClassesRendered.values()) {
        expect(Object.keys(entry).sort()).toEqual(["common", "fontCSS", "responsive"]);
      }
    }
    expect(real.fineline.result.globalClassesRendered.size).toBe(21);
    expect(real.ap.result.globalClassesRendered.size).toBe(40);
  });

  test("compiledCss.classes is CSS in Cwicly's layout: base rules, then max-width queries widest first", () => {
    for (const site of SITES) {
      const css = real[site].result.compiledCss.classes;
      expect(css.startsWith("a:"), site).toBe(false);
      const root = postcss.parse(css);
      const widths = root.nodes.flatMap((n) =>
        n.type === "atrule" && n.name === "media"
          ? [Number(/max-width: (\d+)px/.exec(n.params)![1])]
          : [],
      );
      expect(widths, site).toEqual([992, 576]);
      // Everything outside a query comes first: no plain rule follows an @media.
      const kinds = root.nodes.map((n) => (n.type === "atrule" ? "media" : n.type));
      expect(kinds.indexOf("media"), site).toBeGreaterThan(0);
      expect(
        kinds.slice(kinds.indexOf("media")).every((k) => k === "media"),
        site,
      ).toBe(true);
      // Each cached rule survives the assembly: the same set of rules, wrapped or not.
      const rendered = [...real[site].result.globalClassesRendered.values()];
      const pieces = rendered
        .flatMap((c) => [c.fontCSS, c.common, ...Object.values(c.responsive)])
        .join("");
      const count = (text: string) => {
        let n = 0;
        postcss.parse(text).walkRules(() => {
          n++;
        });
        return n;
      };
      expect(count(css), site).toBe(count(pieces));
    }
  });

  test("the cache is stale on both sites, and the report names what the served file styles that it lacks", () => {
    for (const site of SITES) {
      const [entry] = withCode(real[site].entries, "option.stale");
      expect(entry, site).toMatchObject({
        severity: "warn",
        where: "option:cwicly_global_classes_rendered",
      });
      const { uncached, orphaned } = entry!.data as { uncached: string[]; orphaned: string[] };

      // The served file is the authority: a class it styles but the cache has no entry for is lost
      // to anything built from the option alone.
      const served = readFixtureText(site, "css/cc-global-classes.css");
      const { globalClassNames, globalClassesRendered } = real[site].result;
      const styledByFile = [...globalClassNames]
        .filter(
          ([id, name]) =>
            !globalClassesRendered.has(id) && new RegExp(`\\.${name}(?![\\w-])`).test(served),
        )
        .map(([, name]) => name);
      expect(uncached.sort(), site).toEqual(styledByFile.sort());
      expect(orphaned, site).toEqual(
        [...globalClassesRendered.keys()].filter((id) => !globalClassNames.has(id)),
      );
    }
    expect(withCode(real.fineline.entries, "option.stale")[0]?.data).toMatchObject({
      orphaned: ["3yEPq5XEDBJoOaj"],
    });
    expect(withCode(real.fineline.entries, "option.stale")[0]?.message).toContain(
      "1 entry belongs to a class that no longer exists",
    );
    expect(staleData(real.fineline.entries).uncached).toHaveLength(8);
    expect(staleData(real.ap.entries).uncached).toHaveLength(14);
  });

  test("the cache also predates later edits: fineline's .card-default img is 10rem tall in it and 20rem in the served file", () => {
    const heightOf = (css: string) => {
      const heights: string[] = [];
      postcss.parse(css).walkRules((rule) => {
        if (rule.selector.trim() !== ".card-default img") return;
        rule.walkDecls("height", (d) => void heights.push(d.value));
      });
      return heights;
    };
    expect(heightOf(real.fineline.result.compiledCss.classes)).toEqual(["10rem"]);
    expect(heightOf(readFixtureText("fineline", "css/cc-global-classes.css"))).toEqual(["20rem"]);
  });

  test("assembly follows cc_make_global_css(): fonts once, common, main, then min ascending and max descending", () => {
    const rendered = php({
      one: {
        fontCSS: "@import url(a);",
        common: ".one svg{fill:red}",
        responsive: { lg: ".one{a:1}", md: ".one{a:2}", sm: ".one{a:3}", xl: ".one{a:9}" },
      },
      two: {
        fontCSS: "@import url(a);",
        common: ".two svg{fill:blue}",
        responsive: { lg: ".two{b:1}", md: "", sm: ".two{b:3}", xl: ".two{b:9}" },
      },
      three: {
        fontCSS: "@import url(b);",
        common: "",
        responsive: { lg: "", md: ".three{c:2}", sm: "", xl: "" },
      },
    });
    const list = JSON.stringify({
      xl: { width: 1920 },
      lg: { width: 1366, isMain: true },
      sm: { width: 576 },
      md: { width: 992 },
    });
    const { result } = read(table({ cwicly_global_classes_rendered: rendered, [BP_LIST]: list }));
    expect(result.compiledCss.classes).toBe(
      "@import url(a);@import url(b);" +
        ".one svg{fill:red}.two svg{fill:blue}" +
        ".one{a:1}.two{b:1}" +
        "@media screen and (min-width: 1920px){.one{a:9}.two{b:9}}" +
        "@media screen and (max-width: 992px){.one{a:2}.three{c:2}}" +
        "@media screen and (max-width: 576px){.one{a:3}.two{b:3}}",
    );
  });

  test("a breakpoint key the list no longer has is left out, as Cwicly leaves it out", () => {
    const rendered = php({
      one: { fontCSS: "", common: "", responsive: { lg: ".a{x:1}", tablet: ".a{x:2}" } },
    });
    const { result } = read(table({ cwicly_global_classes_rendered: rendered }));
    expect(result.compiledCss.classes).toBe(".a{x:1}");
  });

  test("the option as plain CSS text (an older Cwicly) is passed through", () => {
    const { result, entries } = read(table({ cwicly_global_classes_rendered: ".a{color:red}" }));
    expect(result.compiledCss.classes).toBe(".a{color:red}");
    expect(result.globalClassesRendered.size).toBe(0);
    expect(withCode(entries, "option.malformed")).toHaveLength(0);
  });

  test("a cache entry with no CSS is not stale, a class with no entry is, and an orphan alone is only info", () => {
    const classes = {
      styled: { attributes: { classID: "styled", paddingTop: { lg: "1rem" } } },
      cachedEmpty: {
        attributes: { classID: "cached-empty", linkWrapperActionLighboxRef: "div-1" },
      },
      bare: { attributes: { classID: "bare" } },
    };
    const cache = (entries: object) => php(entries);
    const base = { cwicly_global_classes: JSON.stringify(classes) };
    const empty = { fontCSS: "", common: "", responsive: { lg: "", md: "", sm: "" } };
    const fresh = read(
      table({
        ...base,
        cwicly_global_classes_rendered: cache({
          styled: { ...empty, common: ".styled{a:b}" },
          cachedEmpty: empty,
        }),
      }),
    );
    expect(withCode(fresh.entries, "option.stale")).toHaveLength(0);

    const lacking = read(
      table({ ...base, cwicly_global_classes_rendered: cache({ cachedEmpty: empty }) }),
    );
    expect(withCode(lacking.entries, "option.stale")[0]).toMatchObject({
      severity: "warn",
      data: { uncached: ["styled"], orphaned: [] },
    });

    const orphan = read(
      table({
        ...base,
        cwicly_global_classes_rendered: cache({
          styled: { ...empty, common: ".styled{a:b}" },
          cachedEmpty: empty,
          gone: empty,
        }),
      }),
    );
    expect(withCode(orphan.entries, "option.stale")[0]).toMatchObject({
      severity: "info",
      data: { uncached: [], orphaned: ["gone"] },
    });
  });

  test("the editor's bookkeeping attributes do not make a class styled; any real attribute does", () => {
    const bookkeeping = {
      htmlAttributes: [{ name: "data-x", value: "y" }],
      relativeStyles: [{ name: "Links", rules: [{ selector: "a" }], id: "r1" }],
      backgroundImageType: "static",
      backgroundType: { lg: "image" },
      fontGlobalStyle: 1,
      fontLocation: "google",
      id: "div-c1",
      backgroundClipPathActive: true,
      ccAClasses: { x: { clientId: "x", classID: "card-x" } },
    };
    const classes = {
      bookkeepingOnly: { attributes: { classID: "plain", ...bookkeeping } },
      zero: { attributes: { classID: "zero", zIndex: 0, ...bookkeeping } },
      flag: {
        attributes: {
          classID: "flag",
          containerLayoutFlexDirectionReverse: { lg: false },
          ...bookkeeping,
        },
      },
      text: { attributes: { classID: "text", fontWeight: { lg: "700" } } },
      blank: {
        attributes: {
          classID: "blank",
          paddingTop: { lg: "" },
          paddingLeft: { lg: "  " },
          listIcon: "",
          nested: [{ a: "" }],
        },
      },
    };
    const { entries } = read(
      table({
        cwicly_global_classes: JSON.stringify(classes),
        cwicly_global_classes_rendered: php({}),
      }),
    );
    // `zero` (a number) and `text` are styled; a boolean `false`, empty strings and bookkeeping are not.
    expect(staleData(entries).uncached).toEqual(["zero", "text"]);
  });

  test("a `true` flag or a value nested in a list makes a class styled; one nested in nothing but blanks does not", () => {
    const classes = {
      flag: { attributes: { classID: "flag", containerLayoutFlexDirectionReverse: { lg: true } } },
      nested: { attributes: { classID: "nested", fontSize: { lg: { md: ["", { x: "1em" }] } } } },
      blanks: { attributes: { classID: "blanks", fontSize: { lg: { md: ["", { x: " " }, []] } } } },
    };
    const { entries } = read(
      table({
        cwicly_global_classes: JSON.stringify(classes),
        cwicly_global_classes_rendered: php({}),
      }),
    );
    expect(staleData(entries).uncached).toEqual(["flag", "nested"]);
  });

  test("damaged compiled CSS options fall back to empty strings and are reported", () => {
    const { result, entries } = read(
      table({ cwicly_global_classes_rendered: "a:3:{s:1:", cwicly_global_css: "[1,2]" }),
    );
    expect(result.compiledCss.classes).toBe("");
    expect(result.globalClassesRendered.size).toBe(0);
    const messages = withCode(entries, "option.malformed").map((e) => e.where);
    expect(messages).toContain("option:cwicly_global_classes_rendered");
    expect(result.compiledCss.global).toBe("[1,2]");
  });

  test("a PHP-serialised string holding the CSS is unwrapped", () => {
    const { result } = read(table({ cwicly_global_css: php("body{margin:0}") }));
    expect(result.compiledCss.global).toBe("body{margin:0}");
  });

  test("global stylesheets keep their source and active flag", () => {
    expect(real.fineline.result.globalStylesheets).toEqual([]);
    expect(real.ap.result.globalStylesheets.map((s) => [s.name, s.active])).toEqual([
      ["block-link", true],
      ["give-wp", true],
      ["overrides", true],
    ]);
    const stored = rawJson<{ name: string; css: string }[]>("ap", "cwicly_global_stylesheets");
    expect(real.ap.result.globalStylesheets.map((s) => s.css)).toEqual(stored.map((s) => s.css));

    const { result, entries } = read(
      table({
        cwicly_global_stylesheets: JSON.stringify([
          { name: "a", css: "x", active: false },
          { name: "b" },
          { css: "y" },
          { name: "c", css: "z", active: "true" },
          { name: "d", css: "w" },
        ]),
      }),
    );
    // A sheet with no `active` key is on: the editor only writes the flag once it is toggled.
    expect(result.globalStylesheets).toEqual([
      { name: "a", css: "x", active: false },
      { name: "c", css: "z", active: true },
      { name: "d", css: "w", active: true },
    ]);
    expect(withCode(entries, "option.malformed")).toHaveLength(2);
  });
});

// ── Fonts ────────────────────────────────────────────────────────────────────────────────────────

describe("fonts", () => {
  test("fineline: seven identical Google links are one font, and the page prints them all", () => {
    const { result } = real.fineline;
    expect(result.globalStyles.fonts).toHaveLength(1);
    const [font] = result.globalStyles.fonts;
    expect(font).toMatchObject({ family: "Source Sans Pro", source: "google" });
    expect(font?.url).toStartWith(
      "https://fonts.googleapis.com/css2?family=Source Sans Pro:ital,wght@0,100;",
    );
    expect(result.globalFontsHtml.match(/<link\b/g)).toHaveLength(7);
    for (const { name, html } of htmlPages("fineline")) {
      // The page escapes the ampersands; the link is otherwise printed exactly as stored.
      expect(html, name).toContain(font!.url!.replaceAll("&", "&amp;"));
      expect(html.match(/fonts\.googleapis\.com\/css2/g), name).toHaveLength(7);
    }
  });

  test("ap: Poppins, one link", () => {
    const { result } = real.ap;
    expect(result.globalStyles.fonts.map((f) => [f.family, f.source])).toEqual([
      ["Poppins", "google"],
    ]);
    expect(result.globalFontsHtml.match(/<link\b/g)).toHaveLength(1);
    for (const { name, html } of htmlPages("ap")) {
      expect(html, name).toContain(result.globalStyles.fonts[0]!.url!.replaceAll("&", "&amp;"));
    }
  });

  test("the families the sites declare are the ones their typography uses, so none is left to the system", () => {
    for (const site of SITES) {
      const { globalStyles } = real[site].result;
      expect(globalStyles.fonts.filter((f) => f.source === "system")).toEqual([]);
      const styles = rawJson(site, "cwicly_global_styles");
      const used = new Set(
        Object.values<{ family?: string }>(styles.styles[styles.activeStyle].themeFonts)
          .map((t) => t.family)
          .filter((family): family is string => Boolean(family)),
      );
      expect(new Set(globalStyles.fonts.map((f) => f.family))).toEqual(used);
    }
  });

  test("the CSS API v1 form, several families, entities, preconnect hints and non-Google links", () => {
    const html =
      `<link rel="preconnect" href="https://fonts.googleapis.com">` +
      `<link rel='stylesheet' href='https://fonts.googleapis.com/css?family=Open+Sans:400,700|Roboto&amp;display=swap'>` +
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400&amp;family=Merriweather&amp;display=swap">` +
      `<link rel="stylesheet" href="https://use.typekit.net/abc1234.css">` +
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto&display=swap">`;
    const { result, entries } = read(table({ cwicly_global_fonts: html }));
    expect(result.globalStyles.fonts.map((f) => f.family)).toEqual([
      "Open Sans",
      "Roboto",
      "Lora",
      "Merriweather",
      "Roboto",
    ]);
    expect(result.globalStyles.fonts[0]?.url).toBe(
      "https://fonts.googleapis.com/css?family=Open+Sans:400,700|Roboto&display=swap",
    );
    expect(result.globalStyles.fonts[2]?.url).toBe(result.globalStyles.fonts[3]?.url);
    const unrecognised = withCode(entries, "option.font-unrecognised");
    expect(unrecognised).toHaveLength(1);
    expect(unrecognised[0]).toMatchObject({
      severity: "info",
      data: { href: "https://use.typekit.net/abc1234.css" },
    });
    expect(result.globalFontsHtml).toBe(html);
  });

  test("only the href attribute counts, not data-href, and attribute order does not matter", () => {
    const html =
      `<link data-href="https://fonts.googleapis.com/css?family=Wrong" rel="stylesheet" href="https://fonts.googleapis.com/css?family=Right">` +
      `<link href='https://fonts.googleapis.com/css?family=Quoted' REL=STYLESHEET>`;
    const { result } = read(table({ cwicly_global_fonts: html }));
    expect(result.globalStyles.fonts.map((f) => f.family)).toEqual(["Right", "Quoted"]);
  });

  test("a stylesheet from another font host is not a Google font even when its URL has a family parameter", () => {
    const html = `<link rel="stylesheet" href="https://fonts.bunny.net/css?family=roboto:400,700">`;
    const { result, entries } = read(table({ cwicly_global_fonts: html }));
    expect(result.globalStyles.fonts).toEqual([]);
    expect(withCode(entries, "option.font-unrecognised")).toHaveLength(1);
    expect(result.globalFontsHtml).toBe(html);
  });

  test("an inline <style> in the fonts option is kept as HTML and reported, not parsed", () => {
    const html = `<style type="text/css">@font-face{font-family:"X";src:url(/x.woff2)}</style>`;
    const { result, entries } = read(table({ cwicly_global_fonts: html }));
    expect(result.globalStyles.fonts).toEqual([]);
    expect(result.globalFontsHtml).toBe(html);
    expect(withCode(entries, "option.font-unrecognised")[0]?.message).toContain("<style>");
  });

  test("the uploads URL that {{CC_UPLOAD_URL}} stands for is the one each rendered page links its Cwicly stylesheets from", () => {
    for (const site of SITES) {
      const { uploadsUrl } = real[site].result;
      expect(uploadsUrl, site).toBe(`${optionsOf(site).get("siteurl")}/wp-content/uploads`);
      for (const { name, html } of htmlPages(site)) {
        const bases = new Set(
          [...html.matchAll(/(https?:\/\/[^'"\s]+?)\/cwicly\/(?:css\/)?cc-[^'"?\s]+\.css/g)].map(
            (m) => m[1],
          ),
        );
        expect([...bases], `${site} ${name}`).toEqual([uploadsUrl]);
      }
    }
  });

  test("the uploads URL has no doubled slash, takes a relative upload_url_path for no URL at all, and needs an http(s) site URL", () => {
    const uploads = (entries: Record<string, string>) => read(table(entries)).result.uploadsUrl;
    expect(uploads({ siteurl: "https://example.com/" })).toBe(
      "https://example.com/wp-content/uploads",
    );
    expect(uploads({ siteurl: "https://example.com///" })).toBe(
      "https://example.com/wp-content/uploads",
    );
    expect(uploads({ siteurl: " http://example.com " })).toBe(
      "http://example.com/wp-content/uploads",
    );
    expect(
      uploads({ upload_url_path: "https://cdn.example.com/up//", siteurl: "https://a.b" }),
    ).toBe("https://cdn.example.com/up");
    // WordPress allows a relative path there; it names no host, so the site URL is what is left.
    expect(uploads({ upload_url_path: "/wp-content/up", siteurl: "https://example.com" })).toBe(
      "https://example.com/wp-content/uploads",
    );
    expect(uploads({ siteurl: "example.com" })).toBeUndefined();
    expect(uploads({ upload_url_path: "cdn.example.com/up" })).toBeUndefined();
  });

  describe("local fonts, in the shape a live site stores them", () => {
    const exo = {
      family: "Exo 2",
      displayName: null,
      category: "Sans Serif",
      size: 287194,
      subsets: ["menu", "latin"],
      fonts: {
        100: { thickness: 1, slant: 1, width: 7, lineHeight: 1.2 },
        "100i": { thickness: 1, slant: 4, width: 7, lineHeight: 1.2 },
      },
      type: "google",
      originalCSS:
        "@font-face  {font-family:'Exo 2';\nfont-display:swap;font-style:normal;font-weight:100 900;src:url({{CC_UPLOAD_URL}}/cwicly/local-fonts/google/Exo%202/latin/Exo%202-100%20900-normal.woff2) format('woff2');unicode-range:U+0000-00FF}" +
        "@font-face  {font-family:'Exo 2';\nfont-display:swap;font-style:italic;font-weight:100 900;src:url({{CC_UPLOAD_URL}}/cwicly/local-fonts/google/Exo%202/latin/Exo%202-100%20900-italic.woff2) format('woff2');unicode-range:U+0000-00FF}\n",
    };
    const montserrat = {
      family: "Montserrat",
      type: "google",
      css: "@font-face{font-family:'Montserrat';src:url(\"{{CC_UPLOAD_URL}}/cwicly/local-fonts/google/Montserrat/latin/m.woff2\")}",
      originalCSS: "@font-face{font-family:'Stale'}",
    };
    const local = {
      siteurl: "https://example.com",
      cwicly_local_fonts: php({
        "google-exo2": exo,
        "google-montserrat": montserrat,
        "google-unused": { ...exo, family: "Unused" },
      }),
      cwicly_local_active_fonts: php(["google-exo2", "google-montserrat"]),
      cwicly_global_css_fonts: php(["google-montserrat"]),
    };

    test("active fonts become local declarations with their @font-face CSS and files", () => {
      const { result, entries } = read(table(local));
      const fonts = result.globalStyles.fonts;
      expect(fonts.map((f) => [f.family, f.source, f.key, f.global])).toEqual([
        ["Exo 2", "local", "google-exo2", false],
        ["Montserrat", "local", "google-montserrat", true],
      ]);
      expect(result.uploadsUrl).toBe("https://example.com/wp-content/uploads");
      expect(fonts[0]?.css).not.toContain("{{CC_UPLOAD_URL}}");
      expect(fonts[0]?.files).toEqual([
        "https://example.com/wp-content/uploads/cwicly/local-fonts/google/Exo%202/latin/Exo%202-100%20900-normal.woff2",
        "https://example.com/wp-content/uploads/cwicly/local-fonts/google/Exo%202/latin/Exo%202-100%20900-italic.woff2",
      ]);
      // The front end prefers `css` over `originalCSS`; quoted urls are read too.
      expect(fonts[1]?.css).toContain("'Montserrat'");
      expect(fonts[1]?.css).not.toContain("Stale");
      expect(fonts[1]?.files).toEqual([
        "https://example.com/wp-content/uploads/cwicly/local-fonts/google/Montserrat/latin/m.woff2",
      ]);
      expect(codesOf(entries).filter((c) => c === "option.malformed")).toHaveLength(0);
    });

    test("upload_url_path wins over siteurl, and without either the placeholder is left for the caller", () => {
      const withPath = read(table({ ...local, upload_url_path: "https://cdn.example.com/up/" }));
      expect(withPath.result.uploadsUrl).toBe("https://cdn.example.com/up");
      expect(withPath.result.globalStyles.fonts[0]?.files?.[0]).toStartWith(
        "https://cdn.example.com/up/cwicly/local-fonts/",
      );

      const bare = read(table({ ...local, siteurl: "" }));
      expect(bare.result.uploadsUrl).toBeUndefined();
      expect(bare.result.globalStyles.fonts[0]?.css).toContain("{{CC_UPLOAD_URL}}");
      expect(bare.result.globalStyles.fonts[0]?.files?.[0]).toStartWith(
        "{{CC_UPLOAD_URL}}/cwicly/",
      );
    });

    test("an uploads URL with replacement-pattern characters is inserted literally", () => {
      const { result } = read(
        table({ ...local, upload_url_path: "https://cdn.example.com/a$&b$'c" }),
      );
      expect(result.globalStyles.fonts[0]?.files?.[0]).toStartWith(
        "https://cdn.example.com/a$&b$'c/cwicly/local-fonts/",
      );
    });

    test("an active font with no definition, family or CSS is skipped and reported", () => {
      const { result, entries } = read(
        table({
          ...local,
          cwicly_local_active_fonts: php([
            "google-missing",
            "google-nofamily",
            "google-nocss",
            "google-exo2",
          ]),
          cwicly_local_fonts: php({
            "google-nofamily": { css: "x" },
            "google-nocss": { family: "N" },
            "google-exo2": exo,
          }),
        }),
      );
      expect(result.globalStyles.fonts.map((f) => f.family)).toEqual(["Exo 2"]);
      const reasons = withCode(entries, "option.malformed").map((e) => e.message);
      expect(reasons).toHaveLength(3);
      expect(reasons.some((m) => m.includes("does not define"))).toBe(true);
      expect(reasons.some((m) => m.includes("without a family"))).toBe(true);
      expect(reasons.some((m) => m.includes("without any CSS"))).toBe(true);
    });

    test("an inlined data: font is part of the CSS but is not a file to download", () => {
      const inlined = {
        family: "Inline",
        css: "@font-face{font-family:Inline;src:url(data:font/woff2;base64,AAAA) format('woff2'),url({{CC_UPLOAD_URL}}/cwicly/local-fonts/i.woff2)}",
      };
      const { result } = read(
        table({
          ...local,
          cwicly_local_fonts: php({ "custom-inline": inlined }),
          cwicly_local_active_fonts: php(["custom-inline"]),
        }),
      );
      const [font] = result.globalStyles.fonts;
      expect(font?.files).toEqual([
        "https://example.com/wp-content/uploads/cwicly/local-fonts/i.woff2",
      ]);
      expect(font?.css).toContain("data:font/woff2;base64,AAAA");
    });

    test("fonts defined but not switched on are not loaded by Cwicly, so they are not declared", () => {
      const { result } = read(table({ ...local, cwicly_local_active_fonts: php([]) }));
      expect(result.globalStyles.fonts).toEqual([]);
    });
  });

  test("a family the typography names that no link or local font declares is left to the system", () => {
    const styles = {
      activeStyle: "style1",
      styles: {
        style1: {
          themeFonts: {
            bodyTypography: { family: "Source Sans Pro", location: "google" },
            h1Typography: { family: '"Helvetica Neue", Arial, sans-serif', location: "google" },
            h2Typography: { family: "sans-serif" },
            linkTypography: { family: "", location: "google" },
            h3Typography: { family: "Montserrat", location: "custom" },
            h4Typography: { family: "inherit" },
          },
          typography: [{ name: "Heading", value: { family: "Georgia, serif" } }],
          globalElements: [
            { tag: "p", value: { fontFamily: "Georgia" } },
            { tag: "code", value: { fontFamily: "Menlo, monospace", fontLocation: "google" } },
          ],
        },
      },
    };
    const html = `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Sans+Pro">`;
    const { result } = read(
      table({ cwicly_global_styles: JSON.stringify(styles), cwicly_global_fonts: html }),
    );
    expect(result.globalStyles.fonts.map((f) => [f.family, f.source])).toEqual([
      ["Source Sans Pro", "google"],
      ["Helvetica Neue", "system"],
      ["Georgia", "system"],
      ["Menlo", "system"],
    ]);
  });
});

// ── Custom code ──────────────────────────────────────────────────────────────────────────────────

describe("custom code", () => {
  test("fineline: the Tag Manager snippets are printed where Cwicly prints them", () => {
    const { customCode, customCodeSnippets } = real.fineline.result;
    const stored = rawJson<Record<string, { position: string; code: string }>>(
      "fineline",
      "cwicly_custom_code",
    );
    expect(customCode.head).toBe(stored["Google Tag Manager"]!.code);
    expect(customCode.bodyOpen).toBe(stored["Google Tag Manager (Body)"]!.code);
    expect(customCode.footer).toBe("");
    expect(customCodeSnippets.map((s) => [s.name, s.position])).toEqual([
      ["Google Tag Manager", "head"],
      ["Google Tag Manager (Body)", "bodyOpen"],
    ]);
    const { html } = htmlPages("fineline").find((p) => p.name === "home.html")!;
    const head = html.indexOf(customCode.head);
    const bodyOpen = html.indexOf(customCode.bodyOpen);
    expect(head).toBeGreaterThan(-1);
    expect(head).toBeLessThan(html.indexOf("</head>"));
    expect(bodyOpen).toBeGreaterThan(html.indexOf("<body"));
    expect(html.indexOf("</body>")).toBeGreaterThan(bodyOpen);
  });

  test("ap prints no custom code, and neither does the reader", () => {
    expect(real.ap.result.customCode).toEqual({ head: "", bodyOpen: "", footer: "" });
    expect(real.ap.result.customCodeSnippets).toEqual([]);
    expect(optionsOf("ap").get("cwicly_custom_code")).toBe("{}");
  });

  test("positions map head, bodyStart and bodyEnd; several snippets in one position are joined in order", () => {
    const code = {
      "First head": { position: "head", code: "<meta name=a>" },
      "Second head": { position: "head", code: "<meta name=b>" },
      Open: { position: "bodyStart", code: "<noscript>x</noscript>" },
      Close: { position: "bodyEnd", code: "<script>y()</script>" },
      Blank: { position: "head", code: "   " },
    };
    const { result, entries } = read(table({ cwicly_custom_code: JSON.stringify(code) }));
    expect(result.customCode).toEqual({
      head: "<meta name=a>\n<meta name=b>",
      bodyOpen: "<noscript>x</noscript>",
      footer: "<script>y()</script>",
    });
    expect(result.customCodeSnippets.map((s) => s.name)).toEqual([
      "First head",
      "Second head",
      "Open",
      "Close",
    ]);
    expect(withCode(entries, "option.malformed")).toEqual([]);
  });

  test("a snippet at a position Cwicly never prints, or with no code, is skipped and reported", () => {
    const code = {
      Footer: { position: "footer", code: "<p>never printed</p>" },
      Nowhere: { code: "<p>x</p>" },
      Empty: { position: "head" },
      Fine: { position: "head", code: "<b>y</b>" },
      Junk: "text",
    };
    const { result, entries } = read(table({ cwicly_custom_code: JSON.stringify(code) }));
    expect(result.customCode.head).toBe("<b>y</b>");
    expect(withCode(entries, "option.malformed")).toHaveLength(4);
    expect(withCode(entries, "option.malformed")[0]?.message).toContain('"footer"');
  });

  test("the option may be PHP-serialised, or `{}` / `[]` when there is none", () => {
    const viaPhp = read(
      table({ cwicly_custom_code: php({ Tag: { position: "head", code: "<i>z</i>" } }) }),
    );
    expect(viaPhp.result.customCode.head).toBe("<i>z</i>");
    for (const empty of ["{}", "[]", ""]) {
      const { result, entries } = read(table({ cwicly_custom_code: empty }));
      expect(result.customCode, empty).toEqual({ head: "", bodyOpen: "", footer: "" });
      expect(withCode(entries, "option.malformed"), empty).toHaveLength(0);
    }
  });
});

// ── Conditions and parts ─────────────────────────────────────────────────────────────────────────

describe("template conditions and global parts", () => {
  test("fineline and ap: every stored rule is empty, so no template is assigned by Cwicly", () => {
    for (const site of SITES) {
      const stored = rawJson(site, "cwicly_conditions");
      const { conditions, templateRules } = real[site].result;
      expect(conditions, site).toEqual(stored);
      expect(
        templateRules.map((t) => t.slug),
        site,
      ).toEqual(Object.keys(stored.include));
      expect(
        templateRules.every((t) => !t.assigned),
        site,
      ).toBe(true);
      for (const t of templateRules) {
        expect(t.include).toMatchObject({
          all: false,
          singular: [],
          archive: [],
          author: [],
          acf: [],
          custom: [],
          combine: "and",
        });
        expect(t.exclude).toMatchObject({ all: false, combine: "and" });
      }
    }
    expect(real.fineline.result.templateRules.map((t) => t.slug)).toEqual([
      "archive-project",
      "wp-custom-template-projects",
    ]);
    expect(real.ap.result.templateRules.map((t) => t.slug)).toEqual([
      "single-post",
      "front-page",
      "author",
    ]);
  });

  test("the editor's own model is merged by template slug", () => {
    const stored = rawJson("fineline", "cwicly_pre_conditions");
    expect(real.fineline.result.preConditions).toEqual(stored);
    const [archive] = real.fineline.result.templateRules;
    expect(archive?.pre).toEqual({
      conditions: [{ condition: "include", type: "archive", postType: "project", data: "all" }],
      includeCombine: "and",
      excludeCombine: "and",
    });
    // The editor lists the archive rule while the compiled rule is empty: only the compiled one runs.
    expect(archive?.assigned).toBe(false);
    // ap's `author` template has no conditions in the editor model at all.
    expect(real.ap.result.templateRules.find((t) => t.slug === "author")?.pre?.conditions).toEqual(
      [],
    );
  });

  // Abridged from a live site's options (littlecocalico), which has real conditions.
  const conditions = {
    include: {
      "wp-custom-template-single-product-unprinted-fabric": {
        all: "false",
        singular: [
          { target: "product", data: "product_cat", extra: 31 },
          { target: "product", data: "product_cat", extra: 36 },
        ],
        archive: [],
        author: [],
        acf: [],
        custom: [],
        includeCondition: "or",
        priority: "2",
        statusCode: 404,
      },
      "page-cart": {
        all: "false",
        singular: [],
        archive: [],
        author: [],
        acf: [],
        custom: [],
        includeCondition: "and",
      },
      everywhere: {
        all: "true",
        singular: [],
        archive: [],
        author: [],
        acf: [],
        custom: [],
        includeCondition: "and",
      },
    },
    exclude: {
      "wp-custom-template-single-product-unprinted-fabric": {
        all: "false",
        singular: [{ target: "page", data: [7] }],
        archive: [],
        author: [],
        acf: [],
        custom: [],
        excludeCondition: "or",
      },
      "page-cart": {
        all: "false",
        singular: [],
        archive: [],
        author: [],
        acf: [],
        custom: [],
        excludeCondition: "and",
      },
      everywhere: {
        all: "false",
        singular: [],
        archive: [],
        author: [],
        acf: [],
        custom: [],
        excludeCondition: "and",
      },
    },
  };
  const pre = {
    "wp-custom-template-single-product-unprinted-fabric-conditionTypeInclude": "or",
    "wp-custom-template-single-product-unprinted-fabric-conditionTypeExclude": "and",
    "wp-custom-template-single-product-unprinted-fabric": [
      {
        condition: "include",
        type: "singular",
        postType: "product",
        data: "product_cat",
        extra: 31,
      },
    ],
    "wp-custom-template-single-product-unprinted-fabric-conditionOverridePage": false,
    "wp-custom-template-single-product-unprinted-fabric-conditionPriority": 0,
    "page-cart": [],
    "page-cart-conditionHideToggle": true,
    "editor-only": [{ condition: "include", type: "archive" }],
  };

  test("a rule with conditions is assigned; one with `all` is too; one with none is not", () => {
    const { result } = read(
      table({
        cwicly_conditions: JSON.stringify(conditions),
        cwicly_pre_conditions: JSON.stringify(pre),
      }),
    );
    const bySlug = Object.fromEntries(result.templateRules.map((t) => [t.slug, t]));
    expect(Object.keys(bySlug)).toEqual([
      "wp-custom-template-single-product-unprinted-fabric",
      "page-cart",
      "everywhere",
      "editor-only",
    ]);
    const fabric = bySlug["wp-custom-template-single-product-unprinted-fabric"]!;
    expect(fabric.assigned).toBe(true);
    expect(fabric.include).toMatchObject({
      all: false,
      combine: "or",
      priority: 2,
      statusCode: 404,
    });
    expect(fabric.include?.singular).toHaveLength(2);
    expect(fabric.exclude).toMatchObject({ combine: "or" });
    expect(fabric.pre).toEqual({
      conditions: [
        {
          condition: "include",
          type: "singular",
          postType: "product",
          data: "product_cat",
          extra: 31,
        },
      ],
      includeCombine: "or",
      excludeCombine: "and",
      overridePage: false,
      priority: 0,
    });
    expect(bySlug["page-cart"]?.assigned).toBe(false);
    expect(bySlug.everywhere?.assigned).toBe(true);
    expect(bySlug.everywhere?.include?.all).toBe(true);
    // A template only the editor model knows about carries no runtime rule.
    expect(bySlug["editor-only"]).toMatchObject({
      assigned: false,
      include: undefined,
      exclude: undefined,
    });
    expect(result.conditions).toEqual(conditions);
  });

  test("a rule is assigned by any one of its lists or by `all`, and by nothing else", () => {
    const rule = (extra: object) => ({
      all: "false",
      singular: [],
      archive: [],
      author: [],
      acf: [],
      custom: [],
      includeCondition: "and",
      ...extra,
    });
    const conditions = {
      include: {
        bySingular: rule({ singular: [{ target: "post" }] }),
        byArchive: rule({ archive: [{ target: "post" }] }),
        byAuthor: rule({ author: [true] }),
        byAcf: rule({ acf: [{ key: "x" }] }),
        byCustom: rule({ custom: [{ target: "userrole" }] }),
        byAll: rule({ all: "true" }),
        none: rule({}),
        allFalseBoolean: rule({ all: false }),
      },
    };
    const { result } = read(table({ cwicly_conditions: JSON.stringify(conditions) }));
    expect(Object.fromEntries(result.templateRules.map((t) => [t.slug, t.assigned]))).toEqual({
      bySingular: true,
      byArchive: true,
      byAuthor: true,
      byAcf: true,
      byCustom: true,
      byAll: true,
      none: false,
      allFalseBoolean: false,
    });
  });

  test("`all` is the string `true`, which is all the plugin's template matcher tests for", () => {
    // theme-maker.php and cc-helpers.php: `'true' === $value->all`. A JSON boolean is not it.
    const rule = (all: unknown) => ({
      all,
      singular: [],
      archive: [],
      author: [],
      acf: [],
      custom: [],
      includeCondition: "and",
    });
    const stored = {
      include: {
        string: rule("true"),
        boolean: rule(true),
        number: rule(1),
        yes: rule("yes"),
        off: rule("false"),
      },
    };
    const { result } = read(table({ cwicly_conditions: JSON.stringify(stored) }));
    expect(
      Object.fromEntries(result.templateRules.map((t) => [t.slug, [t.include?.all, t.assigned]])),
    ).toEqual({
      string: [true, true],
      boolean: [false, false],
      number: [false, false],
      yes: [false, false],
      off: [false, false],
    });
    const parts = {
      fragments: { f: { name: "F", conditions: { include: { header: rule(true) } } } },
    };
    expect(
      read(table({ cwicly_global_parts: JSON.stringify(parts) })).result.fragments[0]?.conditions
        .include.header?.all,
    ).toBe(false);
  });

  test("the editor's override-page flag is read from a boolean or a string, and absent stays absent", () => {
    const pre = {
      a: [],
      "a-conditionOverridePage": "true",
      b: [],
      "b-conditionOverridePage": "false",
      c: [],
      "c-conditionOverridePage": true,
      d: [],
    };
    const { result } = read(table({ cwicly_pre_conditions: JSON.stringify(pre) }));
    const overrides = Object.fromEntries(
      result.templateRules.map((t) => [t.slug, t.pre?.overridePage]),
    );
    expect(overrides).toEqual({ a: true, b: false, c: true, d: undefined });
    expect(result.templateRules.find((t) => t.slug === "d")?.pre).not.toHaveProperty(
      "overridePage",
    );
  });

  test("conditions that cannot be read leave the raw value empty and are reported", () => {
    for (const junk of ["not json", "[1]", '{"include":']) {
      const { result, entries } = read(table({ cwicly_conditions: junk }));
      expect(result.conditions, junk).toEqual({});
      expect(result.templateRules, junk).toEqual([]);
      expect(withCode(entries, "option.malformed").length, junk).toBeGreaterThan(0);
    }
    const { result } = read(
      table({ cwicly_conditions: '{"include":{"a":5,"b":{"all":"true"}},"exclude":"x"}' }),
    );
    expect(result.templateRules.map((t) => [t.slug, t.assigned])).toEqual([["b", true]]);
  });

  test("global parts: fineline's header fragment points at the footer template, ap's fragments have no templates", () => {
    const { globalParts, fragments } = real.fineline.result;
    expect(Object.keys(globalParts)).toEqual(["notices", "account", "fragments"]);
    expect(fragments.map((f) => [f.id, f.name, f.templates.map((t) => t.template)])).toEqual([
      ["globalfooter", "Global Footer", []],
      ["globalheader", "Global Header", ["footer"]],
    ]);
    expect(fragments[1]?.conditions.include.footer).toMatchObject({ all: false, combine: "and" });
    expect(real.ap.result.fragments.map((f) => [f.id, f.templates.length])).toEqual([
      ["globalfooter", 0],
      ["globalheader", 0],
    ]);
    expect(real.ap.result.fragments.map((f) => f.conditions)).toEqual([
      { include: {}, exclude: {} },
      { include: {}, exclude: {} },
    ]);
  });

  test("a user-made fragment with a template, pre-conditions and an everywhere rule (a live site's shape)", () => {
    const parts = {
      notices: { error: { template: "" } },
      account: [],
      fragments: {
        el7nm: {
          name: "Header Fragment",
          templates: [
            {
              template: "header",
              preConditions: [{ condition: "include", type: "all" }],
              conditionTypeInclude: "and",
              conditionTypeExclude: "and",
            },
          ],
          conditions: {
            include: {
              header: {
                all: "true",
                singular: [],
                archive: [],
                author: [],
                acf: [],
                custom: [],
                includeCondition: "and",
              },
            },
            exclude: {
              header: {
                all: "false",
                singular: [],
                archive: [],
                author: [],
                acf: [],
                custom: [],
                excludeCondition: "and",
              },
            },
          },
        },
        broken: "text",
      },
    };
    for (const stored of [JSON.stringify(parts), php(parts)]) {
      const { result } = read(table({ cwicly_global_parts: stored }));
      expect(result.fragments).toHaveLength(1);
      const [fragment] = result.fragments;
      expect(fragment).toMatchObject({ id: "el7nm", name: "Header Fragment" });
      expect(fragment?.templates).toEqual([
        { template: "header", preConditions: [{ condition: "include", type: "all" }] },
      ]);
      expect(fragment?.conditions.include.header?.all).toBe(true);
      expect(fragment?.conditions.exclude.header?.all).toBe(false);
    }
  });
});

// ── Small settings ───────────────────────────────────────────────────────────────────────────────

describe("flags and small settings", () => {
  for (const site of SITES) {
    test(`${site}: optimise and deprecated flags are the stored strings, read without the reader`, () => {
      const stored = optionsOf(site);
      const flag = (option: string, key: string) =>
        new RegExp(`s:\\d+:"${key}";s:\\d+:"true"`).test(stored.get(option)!);
      const { optimise, deprecated } = real[site].result;
      for (const key of [
        "cwiclyDefaults",
        "removeIDsClasses",
        "svgFilter",
        "wordPressGlobalStyles",
        "wordPressEmojis",
        "templatePartWrapper",
        "removeContainerDisplay",
        "flexOptimisation",
      ] as const) {
        expect(optimise[key], key).toBe(flag("cwicly_optimise", key));
      }
      expect(deprecated.oldSectionLayout).toBe(flag("cwicly_deprecated", "oldSectionLayout"));
      expect(deprecated.oldButton).toBe(flag("cwicly_deprecated", "oldButton"));
    });

    test(`${site}: the Tailwind stylesheet is off, as no page links it; dark mode is Cwicly's default, as every page's script says`, () => {
      expect(real[site].result.tailwind).toBe(false);
      expect(optionsOf(site).get("cwicly_tailwind")).toBe("1");
      expect(real[site].result.darkMode).toEqual({
        darkSelectors: ".dark",
        lightSelectors: ".light",
        darkClasses: ["dark"],
        lightClasses: ["light"],
      });
      for (const { name, html } of htmlPages(site)) {
        expect(html, name).not.toContain("cc-tailwind");
        expect(html, name).toContain("dmSelectors='.dark'");
      }
    });

    test(`${site}: no section defaults, no custom pseudos, no global interactions, and Cwicly 1.4.7`, () => {
      const { result } = real[site];
      expect(result.sectionDefaults).toEqual({});
      expect(result.customPseudos).toEqual([]);
      expect(result.globalInteractions).toEqual([]);
      expect(result.version).toBe("1.4.7");
      expect(withCode(real[site].entries, "interaction.dropped")).toHaveLength(0);
    });
  }

  test("the two sites really differ on the optimise and deprecated flags", () => {
    expect(real.fineline.result.deprecated).toEqual({ oldSectionLayout: false, oldButton: false });
    expect(real.ap.result.deprecated).toEqual({ oldSectionLayout: true, oldButton: true });
    expect(real.fineline.result.optimise).toMatchObject({
      cwiclyDefaults: true,
      flexOptimisation: true,
      templatePartWrapper: true,
    });
    expect(real.ap.result.optimise).toMatchObject({
      cwiclyDefaults: false,
      flexOptimisation: false,
      templatePartWrapper: true,
    });
  });

  test("each of the ten flags is on for the string `true` and for no other spelling", () => {
    const OPTIMISE = [
      "cwiclyDefaults",
      "removeIDsClasses",
      "svgFilter",
      "wordPressGlobalStyles",
      "wordPressEmojis",
      "templatePartWrapper",
      "removeContainerDisplay",
      "flexOptimisation",
    ] as const;
    const DEPRECATED = ["oldSectionLayout", "oldButton"] as const;
    const stored = (option: string, key: string, value: unknown) =>
      table({ [option]: JSON.stringify({ [key]: value }) });
    for (const key of OPTIMISE) {
      expect(read(stored("cwicly_optimise", key, "true")).result.optimise[key], key).toBe(true);
      for (const other of [true, 1, "1", "yes", "TRUE", " true", "false", "0", 0, false, null]) {
        expect(
          read(stored("cwicly_optimise", key, other)).result.optimise[key],
          `${key}=${JSON.stringify(other)}`,
        ).toBe(false);
      }
    }
    for (const key of DEPRECATED) {
      expect(read(stored("cwicly_deprecated", key, "true")).result.deprecated[key], key).toBe(true);
      for (const other of [true, 1, "1", "yes", "TRUE", " true", "false", "0", 0, false, null]) {
        expect(
          read(stored("cwicly_deprecated", key, other)).result.deprecated[key],
          `${key}=${JSON.stringify(other)}`,
        ).toBe(false);
      }
    }
    // One flag on leaves every other off: no flag reads another's key.
    for (const key of OPTIMISE) {
      const { optimise } = read(stored("cwicly_optimise", key, "true")).result;
      expect(
        Object.entries(optimise)
          .filter(([, on]) => on)
          .map(([k]) => k),
      ).toEqual([key]);
    }
    for (const key of DEPRECATED) {
      const { deprecated } = read(stored("cwicly_deprecated", key, "true")).result;
      expect(
        Object.entries(deprecated)
          .filter(([, on]) => on)
          .map(([k]) => k),
      ).toEqual([key]);
    }
  });

  test("what the global CSS says about containers and buttons follows the flags the editor consults, and flexOptimisation is not one of them", () => {
    // The editor writes `.cc-cntr{display:flex;flex-direction:column}` unless `oldSectionLayout` or
    // `removeContainerDisplay` is on, and `.cc-btn{display:inline-flex}` unless `oldButton` is.
    // `flexOptimisation` is stored by some sites but read by nothing in Cwicly 1.4.7 or 1.5.0
    // (neither the PHP nor the editor nor the settings screen mentions it): fineline stores it on and
    // still has the container rule.
    for (const site of SITES) {
      const { optimise, deprecated, compiledCss } = real[site].result;
      const containerRule = compiledCss.global.includes(
        ".cc-cntr{display:flex;flex-direction:column}",
      );
      expect(containerRule, site).toBe(
        !deprecated.oldSectionLayout && !optimise.removeContainerDisplay,
      );
      expect(compiledCss.global.includes(".cc-btn{display:inline-flex}"), site).toBe(
        !deprecated.oldButton,
      );
      expect(compiledCss.global.includes(".cc-btn{display:flex;align-items:center}"), site).toBe(
        deprecated.oldButton,
      );
    }
    expect(real.fineline.result.optimise.flexOptimisation).toBe(true);
    expect(real.fineline.result.compiledCss.global).toContain(
      ".cc-cntr{display:flex;flex-direction:column}",
    );
  });

  test("removeContainerDisplay is the flag that takes the container's display away; it is a flag like the others", () => {
    expect(read(table({})).result.optimise.removeContainerDisplay).toBe(false);
    const on = read(table({ cwicly_optimise: php({ removeContainerDisplay: "true" }) }));
    expect(on.result.optimise.removeContainerDisplay).toBe(true);
    expect(on.result.optimise.flexOptimisation).toBe(false);
    const off = read(table({ cwicly_optimise: php({ removeContainerDisplay: "false" }) }));
    expect(off.result.optimise.removeContainerDisplay).toBe(false);
  });

  test("tailwind is on only for the string `true`, which is what the front end tests", () => {
    for (const [value, expected] of [
      ["true", true],
      ["1", false],
      ["false", false],
      ["", false],
      ["yes", false],
    ] as const) {
      expect(read(table({ cwicly_tailwind: value })).result.tailwind, value).toBe(expected);
    }
    expect(read(new Map()).result.tailwind).toBe(false);
  });

  test("every breakpoint and pseudo used by a style attribute in the 8,542 Cwicly blocks of both sites is one the options declare", () => {
    // Which attributes are style attributes is decided from the global classes' own attributes (the
    // same system), not from the breakpoint list under test: any object-valued attribute a class
    // sets that is not structural. A block using an undeclared breakpoint would then show up as a
    // key that does not decompose, instead of being skipped for not looking like a style key.
    const STRUCTURAL = new Set([
      "htmlAttributes",
      "relativeStyles",
      "ccAClasses",
      "folder",
      "primaries",
    ]);
    const styleAttributes = new Set<string>();
    for (const site of SITES) {
      for (const attrs of real[site].result.globalClassAttrs.values()) {
        for (const [name, value] of Object.entries(attrs)) {
          if (
            !STRUCTURAL.has(name) &&
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
          ) {
            styleAttributes.add(name);
          }
        }
      }
    }
    expect(styleAttributes.size).toBeGreaterThan(80);

    for (const site of SITES) {
      const { breakpoints, customPseudos } = real[site].result;
      const bpKeys = breakpoints.map((b) => b.key).sort((a, b) => b.length - a.length);
      const pseudos = new Set([...BUILTIN_PSEUDOS, ...customPseudos, ""]);
      const posts = readFixtureJson<{ post_content: string }[]>(site, "rows/posts.json");
      let keys = 0;
      const stray: string[] = [];
      const walk = (blocks: ReturnType<typeof parse>) => {
        for (const block of blocks) {
          if (block.blockName?.startsWith("cwicly/")) {
            for (const [name, value] of Object.entries(block.attrs ?? {})) {
              if (!styleAttributes.has(name) || value === null || typeof value !== "object")
                continue;
              for (const key of Object.keys(value)) {
                keys++;
                // `rs<bp><id>` is a relative style and `cs<bp><id>` a component variant: the
                // breakpoint follows the prefix, an id (and for rs a pseudo) follows it.
                const relative = /^(?:rs|cs)/.test(key);
                const rest = relative ? key.slice(2) : key;
                const bp = bpKeys.find((b) => rest.startsWith(b));
                if (!bp || (!relative && !pseudos.has(rest.slice(bp.length))))
                  stray.push(`${name}.${key}`);
              }
            }
          }
          walk(block.innerBlocks);
        }
      };
      for (const post of posts) walk(parse(post.post_content ?? ""));
      expect(keys, site).toBeGreaterThan(3000);
      expect(stray, site).toEqual([]);
    }
  });

  test("dark and light selectors: classes are what the darkmode_force token prints", () => {
    const { result } = read(
      table({
        cwicly_darkmode_selectors: '.dark, [data-theme="dark"], .theme-dark.night',
        cwicly_lightmode_selectors: ".day",
      }),
    );
    expect(result.darkMode).toEqual({
      darkSelectors: '.dark, [data-theme="dark"], .theme-dark.night',
      lightSelectors: ".day",
      darkClasses: ["dark", "theme-dark", "night"],
      lightClasses: ["day"],
    });
    expect(read(table({ cwicly_darkmode_selectors: "  " })).result.darkMode.darkSelectors).toBe(
      ".dark",
    );
    expect(
      read(table({ cwicly_darkmode_selectors: php(".dark-mode") })).result.darkMode.darkClasses,
    ).toEqual(["dark-mode"]);
  });

  test("an attribute selector looks like JSON but is text, and is kept as the selector", () => {
    const { result, entries } = read(
      table({
        cwicly_darkmode_selectors: '[data-theme="dark"]',
        cwicly_lightmode_selectors: "[data-theme=light]",
      }),
    );
    expect(result.darkMode).toEqual({
      darkSelectors: '[data-theme="dark"]',
      lightSelectors: "[data-theme=light]",
      darkClasses: [],
      lightClasses: [],
    });
    expect(withCode(entries, "option.malformed")).toEqual([]);
    // The same goes for CSS that starts with a bracket: it is passed through, not parsed.
    expect(
      read(table({ cwicly_global_css: "[hidden]{display:none}" })).result.compiledCss.global,
    ).toBe("[hidden]{display:none}");
  });

  test("custom pseudos: a list, the editor's `{pseudoClasses: [...]}` object, or PHP; built-ins are not special-cased", () => {
    expect(
      read(table({ cwicly_pseudos: '["focus-visible","disabled"]' })).result.customPseudos,
    ).toEqual(["focus-visible", "disabled"]);
    expect(
      read(table({ cwicly_pseudos: '{"pseudoClasses":["checked"," checked ","visited"]}' })).result
        .customPseudos,
    ).toEqual(["checked", "visited"]);
    expect(read(table({ cwicly_pseudos: php(["first-child"]) })).result.customPseudos).toEqual([
      "first-child",
    ]);
    expect(
      read(table({ cwicly_pseudos: php({ pseudoClasses: ["last-child"] }) })).result.customPseudos,
    ).toEqual(["last-child"]);
    expect(read(table({ cwicly_pseudos: "" })).result.customPseudos).toEqual([]);
    const bad = read(table({ cwicly_pseudos: '"focus"' }));
    expect(bad.result.customPseudos).toEqual([]);
    expect(withCode(bad.entries, "option.malformed")).toHaveLength(1);
  });

  test("section defaults keep only what is set", () => {
    const defaults = {
      maxWidth: { lg: "1120px", md: "" },
      width: { lg: "90%" },
      paddingTop: { lg: "" },
      paddingBottom: { lg: "150px", sm: "40px" },
      paddingLeft: "x",
      paddingRight: [],
    };
    expect(read(table({ cwicly_section_defaults: php(defaults) })).result.sectionDefaults).toEqual({
      maxWidth: { lg: "1120px" },
      width: { lg: "90%" },
      paddingBottom: { lg: "150px", sm: "40px" },
    });
  });

  test("global interactions are not carried over, and the report says so", () => {
    const { result, entries } = read(
      table({ cwicly_global_interactions: JSON.stringify([{ id: "x", actions: [] }]) }),
    );
    expect(result.globalInteractions).toEqual([{ id: "x", actions: [] }]);
    expect(withCode(entries, "interaction.dropped")).toMatchObject([
      { severity: "warn", where: "option:cwicly_global_interactions", data: { count: 1 } },
    ]);
    expect(
      withCode(
        read(table({ cwicly_global_interactions: "a:0:{}" })).entries,
        "interaction.dropped",
      ),
    ).toHaveLength(0);
  });

  test("a site that never set global interactions has an empty list of them, and nothing is dropped", () => {
    const { result, entries } = read(new Map());
    expect(result.globalInteractions).toEqual([]);
    expect(withCode(entries, "interaction.dropped")).toHaveLength(0);
    // The option is not one every working site has, so its absence is not reported either.
    expect(entries.map((e) => e.where)).not.toContain("option:cwicly_global_interactions");
    // A value that is neither a list nor a map of them (a stray scalar) is still something dropped.
    for (const scalar of ["5", "true", '"x"']) {
      const one = read(table({ cwicly_global_interactions: scalar }));
      expect(withCode(one.entries, "interaction.dropped")[0]?.data, scalar).toEqual({ count: 1 });
    }
  });

  test("the built-in pseudos are the five the editor's generator loops over, and every one is a suffix a style key may carry", () => {
    // The editor: `var L = ["hover", "active", "focus", "before", "after"]`. The corpus uses only
    // hover, before and active, so nothing but this list pins the other two.
    expect([...BUILTIN_PSEUDOS]).toEqual(["hover", "active", "focus", "before", "after"]);
    const { breakpoints, customPseudos } = real.fineline.result;
    expect(customPseudos).toEqual([]);
    const accepted = new Set([...BUILTIN_PSEUDOS, ...customPseudos, ""]);
    const bpKeys = breakpoints.map((b) => b.key).sort((a, b) => b.length - a.length);
    const split = (key: string) => {
      const bp = bpKeys.find((b) => key.startsWith(b));
      return bp && accepted.has(key.slice(bp.length)) ? [bp, key.slice(bp.length)] : undefined;
    };
    for (const pseudo of BUILTIN_PSEUDOS) {
      for (const bp of bpKeys)
        expect(split(`${bp}${pseudo}`), `${bp}${pseudo}`).toEqual([bp, pseudo]);
    }
    expect(split("lgvisited")).toBeUndefined();
    expect(split("lg")).toEqual(["lg", ""]);
    // …and the stored global classes of both sites, whose style attributes are keyed
    // `<breakpoint><pseudo>`, use two of the five and nothing the list lacks (ap's blocks use `before`
    // too, which the corpus-wide test below covers).
    const STRUCTURAL = new Set([
      "htmlAttributes",
      "relativeStyles",
      "ccAClasses",
      "folder",
      "primaries",
    ]);
    const used = new Set<string>();
    for (const site of SITES) {
      for (const attrs of real[site].result.globalClassAttrs.values()) {
        for (const [name, value] of Object.entries(attrs)) {
          if (STRUCTURAL.has(name) || value === null || typeof value !== "object") continue;
          if (Array.isArray(value)) continue;
          for (const key of Object.keys(value)) {
            // `rs<bp><id>` is a relative style and `cs<bp><id>` a component variant: the breakpoint
            // follows the prefix and an id, not a pseudo, follows it.
            if (/^(?:rs|cs)/.test(key)) {
              expect(
                bpKeys.some((b) => key.slice(2).startsWith(b)),
                `${site} ${name}.${key}`,
              ).toBe(true);
              continue;
            }
            const found = split(key);
            expect(found, `${site} ${name}.${key}`).toBeDefined();
            if (found?.[1]) used.add(found[1]);
          }
        }
      }
    }
    expect([...used].sort()).toEqual(["active", "hover"]);
  });

  test("an optimise or deprecated flag is on only for the string `true`, as every place the plugin reads one tests it", () => {
    // PHP: `isset($option[$key]) && 'true' === $option[$key]` (class-backend.php, class-frontend.php,
    // class-setup.php, class-settings.php, class-actions.php), and the settings screen writes the
    // strings "true" and "false". A boolean or a number a hand edit left there is off to Cwicly.
    const optimise = {
      svgFilter: "true",
      wordPressEmojis: true,
      removeIDsClasses: 1,
      cwiclyDefaults: "false",
      templatePartWrapper: "yes",
      wordPressGlobalStyles: "1",
      removeContainerDisplay: "true",
      flexOptimisation: "TRUE",
    };
    const deprecated = { oldSectionLayout: "true", oldButton: true };
    for (const stored of [
      { cwicly_optimise: JSON.stringify(optimise), cwicly_deprecated: JSON.stringify(deprecated) },
      { cwicly_optimise: php(optimise), cwicly_deprecated: php(deprecated) },
    ]) {
      const { result } = read(table(stored));
      expect(result.optimise).toEqual({
        cwiclyDefaults: false,
        removeIDsClasses: false,
        svgFilter: true,
        wordPressGlobalStyles: false,
        wordPressEmojis: false,
        templatePartWrapper: false,
        removeContainerDisplay: true,
        flexOptimisation: false,
      });
      expect(result.deprecated).toEqual({ oldSectionLayout: true, oldButton: false });
    }
  });
});

// ── Keys that Object.prototype also answers to ───────────────────────────────────────────────────

describe("stored names that are also Object.prototype members", () => {
  // Template slugs, CSS properties, breakpoints, styles and fonts are all names a site chose, and
  // each is a key of a dictionary here. None of that may be looked up through the prototype chain
  // (`constructor` is a function, `__proto__` is Object.prototype) or assigned through it. Written as
  // raw JSON: an object literal with a `__proto__` key sets a prototype instead of making a key.
  const RULE =
    '{"all":"true","singular":[],"archive":[],"author":[],"acf":[],"custom":[],"includeCondition":"and"}';
  const NAMES = ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"];

  for (const slug of NAMES) {
    test(`a template called ${slug} that has only an exclude rule leaves the conditions readable`, () => {
      const { result, entries } = read(
        table({
          cwicly_conditions: `{"include":{"home":${RULE}},"exclude":{${JSON.stringify(slug)}:${RULE}}}`,
        }),
      );
      expect(
        result.templateRules.map((t) => [t.slug, t.assigned, t.include?.all, t.exclude?.all]),
      ).toEqual([
        ["home", true, true, undefined],
        [slug, false, undefined, true],
      ]);
      expect(withCode(entries, "option.malformed")).toEqual([]);
    });
  }

  test("a template called __proto__ or constructor under `include` is a template like any other", () => {
    for (const slug of ["constructor", "__proto__"]) {
      const { result, entries } = read(
        table({
          cwicly_conditions: `{"include":{${JSON.stringify(slug)}:${RULE},"home":${RULE}},"exclude":{}}`,
        }),
      );
      expect(
        result.templateRules.map((t) => [t.slug, t.assigned]),
        slug,
      ).toEqual([
        [slug, true],
        ["home", true],
      ]);
      expect(withCode(entries, "option.malformed"), slug).toEqual([]);
    }
  });

  test("a rule set whose template is called __proto__ does not take over the others' lookups", () => {
    // Were `include` assigned through `__proto__`, `include.singular` would be this rule's list.
    const { result } = read(
      table({
        cwicly_conditions: `{"include":{"__proto__":${RULE},"singular":{"all":"false"}},"exclude":{}}`,
      }),
    );
    expect(result.templateRules.map((t) => [t.slug, t.include?.all, t.assigned])).toEqual([
      ["__proto__", true, true],
      ["singular", false, false],
    ]);
  });

  test("a template known only to the editor's model, and called constructor, is still a template", () => {
    const { result, entries } = read(
      table({
        cwicly_pre_conditions:
          '{"constructor":[{"condition":"include","type":"all"}],"constructor-conditionTypeInclude":"or"}',
      }),
    );
    expect(result.templateRules).toMatchObject([
      { slug: "constructor", assigned: false, pre: { includeCombine: "or" } },
    ]);
    expect(result.templateRules[0]?.include).toBeUndefined();
    expect(withCode(entries, "option.malformed")).toEqual([]);
  });

  test("a CSS property or an element called __proto__ is data in the section defaults and the theme fonts", () => {
    const { result } = read(
      table({
        cwicly_section_defaults: '{"__proto__":{"lg":"10px"},"paddingTop":{"lg":"4px"}}',
        cwicly_global_styles:
          '{"activeStyle":"style1","styles":{"style1":{"themeFonts":{"__proto__":{"family":"Evil"},"bodyTypography":{"family":"Ok"}}}}}',
      }),
    );
    expect(Object.keys(result.sectionDefaults)).toEqual(["__proto__", "paddingTop"]);
    expect(Object.getPrototypeOf(result.sectionDefaults)).toBe(Object.prototype);
    expect(result.sectionDefaults.lg).toBeUndefined();
    expect(result.sectionDefaults.paddingTop).toEqual({ lg: "4px" });
    const { themeFonts } = result.globalStyles;
    expect(Object.keys(themeFonts)).toEqual(["__proto__", "bodyTypography"]);
    expect(Object.getPrototypeOf(themeFonts)).toBe(Object.prototype);
    expect((themeFonts as Record<string, unknown>).family).toBeUndefined();
    expect(({} as Record<string, unknown>).lg).toBeUndefined();
    expect(({} as Record<string, unknown>).family).toBeUndefined();
  });

  test("a breakpoint with no CSS in the per-class cache is left out of the class's responsive map", () => {
    const rendered = php({
      one: { fontCSS: "", common: "", responsive: { lg: ".a{x:1}", md: "", sm: "" } },
    });
    const { result } = read(table({ cwicly_global_classes_rendered: rendered }));
    expect(result.globalClassesRendered.get("one")?.responsive).toEqual({ lg: ".a{x:1}" });
  });

  test("a breakpoint called __proto__ in the per-class cache is kept as data", () => {
    // The cache is usually PHP-serialised, but `decodeOption` reads the JSON the editor's REST calls
    // send too, and a JSON key survives to this module.
    const rendered =
      '{"one":{"fontCSS":"","common":"","responsive":{"lg":".a{x:1}","__proto__":".b{y:2}"}}}';
    const { result } = read(table({ cwicly_global_classes_rendered: rendered }));
    const one = result.globalClassesRendered.get("one");
    expect(Object.keys(one?.responsive ?? {})).toEqual(["lg", "__proto__"]);
    expect(Object.getPrototypeOf(one?.responsive)).toBe(Object.prototype);
  });

  test("in PHP-serialised data a __proto__ key is lost by the decoder before this module sees it, and pollutes nothing", () => {
    // php-serialize builds its arrays with `array[key] = value`, so the key never becomes data; the
    // rest of the array is intact, and neither Object.prototype nor the array's siblings change.
    const raw = 'a:2:{s:2:"lg";s:7:".a{x:1}";s:9:"__proto__";a:1:{s:8:"polluted";i:1;}}';
    const d = decodeOption(raw);
    expect(d).toMatchObject({ kind: "value", format: "php" });
    expect(Object.keys((d as { value: object }).value)).toEqual(["lg"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(
      ((d as { value: Record<string, unknown> }).value as Record<string, unknown>).polluted,
    ).toBeUndefined();
  });

  test("a snippet whose position is the name of an Object.prototype member is skipped and reported, not printed", () => {
    const code = {
      Odd: { position: "toString", code: "<b>x</b>" },
      Fine: { position: "head", code: "<i>y</i>" },
    };
    const { result, entries } = read(table({ cwicly_custom_code: JSON.stringify(code) }));
    expect(result.customCode).toEqual({ head: "<i>y</i>", bodyOpen: "", footer: "" });
    expect(result.customCodeSnippets.map((s) => s.name)).toEqual(["Fine"]);
    expect(withCode(entries, "option.malformed")).toHaveLength(1);
    expect(withCode(entries, "option.malformed")[0]?.message).toContain('"toString"');
  });

  test("an activeStyle called __proto__, constructor or toString is not a style, however Object.prototype answers for it", () => {
    const colors = [{ id: "a", name: "A", color: "#111", variable: "c-1" }];
    for (const wanted of ["__proto__", "constructor", "toString"]) {
      const { result, entries } = read(stylesTable({ style1: { name: "One", colors } }, wanted));
      expect(result.globalStyles.activeStyle, wanted).toBe("style1");
      expect(result.globalStyles.activeStyleName, wanted).toBe("One");
      expect(result.globalStyles.colors, wanted).toHaveLength(1);
      expect(withCode(entries, "option.malformed")[0]?.message, wanted).toContain(
        `${JSON.stringify(wanted)}, which does not exist`,
      );
    }
  });

  test("an active local font called __proto__ or constructor is reported as undefined, not found on Object.prototype", () => {
    const { result, entries } = read(
      table({ cwicly_local_active_fonts: '["__proto__","constructor"]', cwicly_local_fonts: "{}" }),
    );
    expect(result.globalStyles.fonts).toEqual([]);
    const reasons = withCode(entries, "option.malformed").map((e) => e.message);
    expect(reasons).toHaveLength(2);
    expect(reasons.every((m) => m.includes("does not define"))).toBe(true);
  });
});

// ── Missing, malformed, hostile ──────────────────────────────────────────────────────────────────

describe("missing and malformed options", () => {
  const EXPECTED_MISSING: [string, string][] = [
    ["cwicly_global_styles", "warn"],
    ["cwicly_global_classes", "warn"],
    ["cwicly_global_css", "warn"],
    ["cwicly_global_classes_rendered", "info"],
    ["cwicly_global_stylesheets", "info"],
    ["cwicly_global_stylesheets_rendered", "info"],
    ["cwicly_custom_code", "info"],
    ["cwicly_conditions", "info"],
    ["cwicly_pre_conditions", "info"],
    ["cwicly_global_parts", "info"],
    ["cwicly_section_defaults", "info"],
    ["cwicly_optimise", "info"],
    ["cwicly_deprecated", "info"],
    ["cwicly_db_version", "info"],
  ];

  test("an empty table yields empty values, Cwicly's default breakpoints, and one entry per missing option", () => {
    const { result, entries } = read(new Map());
    expect(result.breakpoints.map((b) => b.key)).toEqual(["lg", "md", "sm"]);
    expect(result.globalStyles).toMatchObject({
      colors: [],
      fonts: [],
      activeStyle: "style1",
      typography: [],
      globalElements: [],
    });
    expect(result.globalClassNames.size).toBe(0);
    expect(result.compiledCss).toEqual({ global: "", classes: "", stylesheets: "" });
    expect(result.customCode).toEqual({ head: "", bodyOpen: "", footer: "" });
    expect(result.conditions).toEqual({});
    expect(result.globalParts).toEqual({});
    expect(result.version).toBeUndefined();
    expect(result.uploadsUrl).toBeUndefined();
    expect(result.tailwind).toBe(false);

    const missing = withCode(entries, "option.missing");
    expect(missing.map((e) => [e.where?.replace("option:", ""), e.severity])).toEqual(
      EXPECTED_MISSING,
    );
    expect(codesOf(entries).filter((c) => c !== "option.missing")).toEqual(["option.default"]);
    expect(entries.every((e) => e.where?.startsWith("option:"))).toBe(true);
  });

  test("the fixture sites have every expected option, so nothing is reported missing", () => {
    for (const site of SITES) {
      expect(withCode(real[site].entries, "option.missing"), site).toEqual([]);
      expect(withCode(real[site].entries, "option.malformed"), site).toEqual([]);
      expect(withCode(real[site].entries, "option.default"), site).toEqual([]);
    }
  });

  test("the whole report for each site is exactly these entries", () => {
    const summary = (site: Site) => real[site].entries.map((e) => `${e.severity} ${e.code}`);
    expect(summary("fineline")).toEqual([
      "info option.color-unnamed",
      "info option.color-duplicate",
      "info option.color-duplicate",
      "info option.color-duplicate",
      "info option.color-duplicate",
      "warn option.stale",
    ]);
    expect(summary("ap")).toEqual([
      "warn option.color-unresolved",
      "warn option.color-unresolved",
      "warn option.stale",
    ]);
  });

  test("an option that is plain text where structure is needed is reported, and ignored", () => {
    const structured = [
      "cwicly_global_styles",
      "cwicly_global_classes",
      "cwicly_conditions",
      "cwicly_pre_conditions",
      "cwicly_global_parts",
      "cwicly_custom_code",
      "cwicly_global_stylesheets",
      "cwicly_optimise",
      "cwicly_deprecated",
      "cwicly_section_defaults",
      "cwicly_global_interactions",
      "cwicly_pseudos",
      "cwicly_local_fonts",
      "cwicly_local_active_fonts",
    ];
    for (const name of structured) {
      const { entries } = read(table({ [name]: "just some text" }));
      const own = entries.filter(
        (e) => e.where === `option:${name}` && e.code === "option.malformed",
      );
      expect(own.length, name).toBeGreaterThanOrEqual(1);
      expect(
        own.every((e) => e.severity === "warn"),
        name,
      ).toBe(true);
    }
  });

  test("values a caller has already parsed are used as they are, and the wrong kind is reported", () => {
    const options = new Map<string, unknown>([
      [BP_LIST, { lg: { width: 1366, isMain: true }, md: { width: 800 } }],
      ["cwicly_global_classes", [1, 2, 3]],
      ["cwicly_global_css", 42],
      ["cwicly_global_styles", null],
      ["cwicly_custom_code", true],
    ]);
    const { entries, report } = collector();
    const result = readCwiclyOptions(options as unknown as Map<string, string>, report);
    expect(result.breakpoints.map((b) => b.width)).toEqual([1366, 800]);
    expect(result.compiledCss.global).toBe("");
    expect(result.globalClassNames.size).toBe(0);
    const malformed = withCode(entries, "option.malformed").map((e) => e.where);
    expect(malformed).toContain("option:cwicly_global_classes");
    expect(malformed).toContain("option:cwicly_global_css");
    expect(malformed).toContain("option:cwicly_custom_code");
    expect(withCode(entries, "option.missing").map((e) => e.where)).toContain(
      "option:cwicly_global_styles",
    );
  });

  test("a section that fails falls back to its empty value and says so, instead of throwing", () => {
    // Nothing a stored value can do makes a section throw, so the safety net is exercised by
    // breaking a builtin for the length of one synchronous read.
    const breakages: [owner: object, key: PropertyKey][] = [
      [RegExp.prototype, Symbol.matchAll],
      [Array.prototype, "flatMap"],
      [Array.prototype, "filter"],
      [Array.prototype, "map"],
      [Object, "entries"],
    ];
    for (const site of SITES) {
      for (const [owner, key] of breakages) {
        const original = Object.getOwnPropertyDescriptor(owner, key)!;
        const { entries, report } = collector();
        let result: CwiclyOptionsFull | undefined;
        let threw: unknown;
        Object.defineProperty(owner, key, {
          ...original,
          value: () => {
            throw new Error("boom");
          },
        });
        try {
          result = readCwiclyOptions(optionsOf(site), report);
        } catch (error) {
          threw = error;
        } finally {
          Object.defineProperty(owner, key, original);
        }
        const label = `${site} ${String(key)}`;
        expect(threw, label).toBeUndefined();
        wellFormed(result!);
        expect(
          entries.some(
            (e) => e.code === "option.malformed" && e.message.includes("could not be read (boom)"),
          ),
          label,
        ).toBe(true);
        // A failed breakpoint section is Cwicly's defaults, never an empty list.
        if (key === Object.entries.name) {
          expect(
            result!.breakpoints.map((b) => b.width),
            label,
          ).toEqual([1366, 992, 576]);
        }
      }
    }
  });

  test("a throwing report sink and a missing report do not stop the read", () => {
    const hostile: Report = {
      add: () => {
        throw new Error("sink exploded");
      },
      entries: () => [],
    };
    const result = readCwiclyOptions(optionsOf("fineline"), hostile);
    expect(result.globalStyles.colors).toHaveLength(22);
    expect(readCwiclyOptions(optionsOf("ap")).globalClassNames.size).toBe(54);
  });

  test("a table that cannot be read at all yields the empty result", () => {
    const hostile = new Map<string, string>();
    hostile.get = () => {
      throw new Error("no");
    };
    expect(readCwiclyOptions(hostile).breakpoints).toHaveLength(3);
    expect(readCwiclyOptions(undefined as unknown as Map<string, string>).breakpoints).toHaveLength(
      3,
    );
    expect(readCwiclyOptions(null as unknown as Map<string, string>).media["--"]).toBe("1366px");
  });

  test("reading does not change the table, and reading twice gives the same answer", () => {
    for (const site of SITES) {
      const options = new Map(optionsOf(site));
      const before = JSON.stringify([...options]);
      const a = readCwiclyOptions(options);
      const b = readCwiclyOptions(options);
      expect(JSON.stringify([...options])).toBe(before);
      expect(a).toEqual(b);
      expect(a).toEqual(real[site].result);
    }
  });

  test("every option mutated every way a damaged row can be still yields a well-formed result", () => {
    let seed = 20260930;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    const mutate = (value: string): unknown => {
      switch (Math.floor(rand() * 12)) {
        case 0:
          return value.slice(0, Math.floor(rand() * value.length));
        case 1:
          return value.slice(Math.floor(rand() * value.length));
        case 2:
          return value.replace(/[{[]/, (c) => (c === "{" ? "[" : "{"));
        case 3: {
          const i = Math.floor(rand() * value.length);
          return value.slice(0, i) + value.slice(i + 1);
        }
        case 4:
          return pick([
            "null",
            "[]",
            "{}",
            "0",
            "true",
            '""',
            "a:0:{}",
            "N;",
            "a:1:{",
            's:5:"ab";',
          ]);
        case 5:
          return JSON.stringify(value);
        case 6:
          return value + pick(["}", "]", '"', ";", "\u0000", "\ufeff"]);
        case 7:
          return pick([5, true, null, ["x"], { a: 1 }, 12345678901234567890n]);
        case 8:
          return value.replace(/\d+/, "-1");
        case 9:
          return value.replaceAll('"', "'");
        case 10:
          return value.toUpperCase();
        default:
          return "";
      }
    };
    for (const site of SITES) {
      const names = [...optionsOf(site).keys()].filter(
        (n) => n.startsWith("cwicly_") || n === "siteurl",
      );
      for (let i = 0; i < 150; i++) {
        const options = new Map<string, unknown>(optionsOf(site));
        for (let k = 0; k < 1 + Math.floor(rand() * 6); k++) {
          const name = pick(names);
          options.set(name, mutate(String(options.get(name))));
        }
        const { entries, report } = collector();
        let result!: CwiclyOptionsFull;
        expect(() => {
          result = readCwiclyOptions(options as Map<string, string>, report);
        }, `${site} #${i}`).not.toThrow();
        wellFormed(result);
        for (const e of entries) {
          expect(e.where, `${site} #${i}`).toStartWith("option:");
          expect(["info", "warn", "error"]).toContain(e.severity);
          expect(e.code).toMatch(/^[a-z]+\.[a-z-]+$/);
        }
      }
    }
  });
});
