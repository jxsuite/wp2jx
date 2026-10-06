/**
 * Cwicly's real generated stylesheets, committed under `tests/fixtures/<site>/css`, as a `CssSource`
 * plus the few facts a test needs to read them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dirCssSource } from "../../src/cwicly/css-source.ts";
import type { Breakpoint, CssSource } from "../../src/types.ts";
import { fixtureDir, readFixtureJson } from "./fixture-db.ts";

export const FIXTURE_SITES = ["fineline", "ap"] as const;
export type FixtureSite = (typeof FIXTURE_SITES)[number];

/**
 * lg 1366 (main), md 992 (max), sm 576 (max): the `cwicly_breakpoints_list` of both fixture sites,
 * written out so that CSS tests do not depend on the options module.
 */
export const FIXTURE_BREAKPOINTS: Breakpoint[] = [
  { key: "lg", width: 1366, isMain: true, direction: "none" },
  { key: "md", width: 992, isMain: false, direction: "max" },
  { key: "sm", width: 576, isMain: false, direction: "max" },
];

export function fixtureCssDir(site: string): string {
  return join(fixtureDir(site), "css");
}

/** A `CssSource` over `tests/fixtures/<site>/css` (the files sit directly in it). */
export function fixtureCssSource(site: string): CssSource {
  return dirCssSource(fixtureCssDir(site));
}

/** Every stylesheet name the fixture holds, sorted. */
export function fixtureCssNames(site: string): string[] {
  return readdirSync(fixtureCssDir(site))
    .filter((file) => file.endsWith(".css"))
    .sort();
}

export function readFixtureCss(site: string, name: string): string {
  return readFileSync(join(fixtureCssDir(site), name), "utf8");
}

/**
 * The compiled CSS Cwicly keeps in an option (`cwicly_global_css`, `cwicly_global_stylesheets_rendered`):
 * the same dialect as the files, delivered as a string by the options module. Null when the option is
 * absent or empty.
 */
export function fixtureOptionCss(site: string, option: string): string | null {
  const rows = readFixtureJson<{ option_name: string; option_value: string | null }[]>(
    site,
    "rows/options.json",
  );
  const value = rows.find((row) => row.option_name === option)?.option_value;
  return value === undefined || value === null || value === "" ? null : value;
}
