/**
 * The migration report: everything the converter could not carry over, or carried over imperfectly.
 * `migration-report.md` is the punch list a person works through; `migration-report.json` keeps
 * every entry for tooling. Nothing here decides what is worth reporting, only how it is collected
 * and shown.
 */
import type { Report, ReportEntry, Severity } from "./types.ts";

/** Display order: what needs attention first. */
export const SEVERITIES: readonly Severity[] = ["error", "warn", "info"];

/** How many example locations a markdown group lists before it says "+N more". */
const EXAMPLES_PER_GROUP = 10;

function assertEntry(entry: ReportEntry): void {
  if (!SEVERITIES.includes(entry.severity)) {
    throw new TypeError(
      `report entry ${JSON.stringify(entry.code)} has severity ${JSON.stringify(entry.severity)}, expected one of ${SEVERITIES.join(", ")}`,
    );
  }
  if (typeof entry.code !== "string" || entry.code === "") {
    throw new TypeError(
      `report entry needs a non-empty string code (message: ${JSON.stringify(entry.message)})`,
    );
  }
  if (typeof entry.message !== "string") {
    throw new TypeError(`report entry ${JSON.stringify(entry.code)} needs a string message`);
  }
}

/**
 * An in-memory collector. Entries are kept in the order they were added; `entries()` hands back a
 * snapshot, so a caller can hold it while conversion goes on adding. A severity outside
 * `error | warn | info` is a bug in the caller and throws, because the renderers group by it.
 */
export function createReport(): Report {
  const list: ReportEntry[] = [];
  return {
    add(entry: ReportEntry): void {
      assertEntry(entry);
      // Copied so a caller that reuses one object for several entries cannot rewrite earlier ones.
      list.push({ ...entry });
    },
    entries(): readonly ReportEntry[] {
      return list.slice();
    },
  };
}

export interface ReportSummary {
  total: number;
  /** Always has all three keys, zero when a severity has no entries. */
  bySeverity: Record<Severity, number>;
  /** Most frequent first, ties by code. A code used at two severities is counted once, across both. */
  byCode: Record<string, number>;
}

export function summarise(entries: readonly ReportEntry[]): ReportSummary {
  const bySeverity: Record<Severity, number> = { error: 0, warn: 0, info: 0 };
  const codes = new Map<string, number>();
  for (const entry of entries) {
    assertEntry(entry);
    bySeverity[entry.severity]++;
    codes.set(entry.code, (codes.get(entry.code) ?? 0) + 1);
  }
  const byCode: Record<string, number> = {};
  for (const [code, count] of [...codes].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])))
    byCode[code] = count;
  return { total: entries.length, bySeverity, byCode };
}

/** Locale-independent string order, so the report is byte-identical on every machine. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Entries grouped by severity and code; codes in alphabetical order, entries in insertion order within a group. */
function group(
  entries: readonly ReportEntry[],
): { severity: Severity; code: string; entries: ReportEntry[] }[] {
  const groups = new Map<string, { severity: Severity; code: string; entries: ReportEntry[] }>();
  for (const entry of entries) {
    assertEntry(entry);
    const key = `${entry.severity}\0${entry.code}`;
    let g = groups.get(key);
    if (!g) {
      g = { severity: entry.severity, code: entry.code, entries: [] };
      groups.set(key, g);
    }
    g.entries.push(entry);
  }
  return [...groups.values()].sort((a, b) => compare(a.code, b.code));
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Whitespace of every kind, and every run of it, as one space; nothing at either end. */
const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();

/** A code span that survives backticks inside the text. */
function codeSpan(text: string): string {
  const oneLine = collapse(text);
  const longest = Math.max(0, ...[...oneLine.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const pad = oneLine.startsWith("`") || oneLine.endsWith("`") ? " " : "";
  return `${fence}${pad}${oneLine}${pad}${fence}`;
}

/**
 * What would mean something to a Markdown parser in the middle of a line: a backslash, a code span,
 * emphasis, a link or reference, raw HTML, GFM strikethrough, and an `&` that would read as a character
 * reference (`&amp;`, `&#35;`). Every one of these is an ASCII punctuation character, and any of those
 * can be backslash-escaped, so the reader gets back exactly the character that was written.
 */
const INLINE_MARKUP = /[\\`*_[<~]|&(?=#?[A-Za-z0-9]+;)/g;
/** The two spellings GFM turns into a link by itself: `http(s)://…` and `www.…`. */
const BARE_URL_START = /(https?):(?=\/\/)|(www)\./gi;

/**
 * One line of prose that a CommonMark parser shows exactly as written. A message is free text, and the
 * converter's own messages name HTML tags (`<script>`, `<div>`), tokens (`{image=12}`, `<ccd>…</ccd>`), selectors
 * (`[class*=cc-]`) and identifiers (`a_b_c`). Left alone, a line starting `<script>` opens an HTML block
 * that nothing closes and swallows every group after it, `---` is a rule, `[x]: y` a link definition, a
 * fence a code block, and `<div>` inside a line is a tag the reader never sees.
 *
 * So the inline characters above are escaped wherever they are, and what would open a block is escaped
 * where it can only matter, at the start of the line: `#` (heading), `>` (quote), `+` and `-` (list,
 * and `---`), `=`, and the `.` or `)` of `1.` (an ordered list; a backslash before the digit is not an
 * escape). Also a run of `#` at the end, which a heading would take for its closing sequence.
 *
 * A backslash is not read inside a bare URL that GFM has turned into a link, and the link text would
 * show it. So the colon of `https://` and the dot of `www.` are escaped as well: no URL becomes a link
 * by itself, and the rest of it is text like any other. (The place for a clickable address is the
 * entry's `url`, which {@link location} writes as an explicit autolink. A bare e-mail address GFM may
 * still link, and shows unchanged.)
 */
function prose(text: string): string {
  return collapse(text)
    .replace(INLINE_MARKUP, "\\$&")
    .replace(BARE_URL_START, (_, scheme: string | undefined, www: string | undefined) =>
      scheme === undefined ? `${www}\\.` : `${scheme}\\:`,
    )
    .replace(/^[#>+=-]/, "\\$&")
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, "$1\\$2")
    .replace(/(\s)(#+)$/, "$1\\$2");
}

/**
 * The site as the title shows it. It is normally an address, which GFM links by itself and shows
 * unchanged, so a plain one is left as it is; anything else is prose. "Plain" means the whole text is
 * one URL of the characters people write in an origin and a path, ending where the parser would end
 * the link too, so nothing around it can be pulled into the link.
 */
function siteTitle(site: string): string {
  const text = collapse(site);
  const plain =
    /^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?(?:\/[A-Za-z0-9._~/%?=&#+-]*)?$/i.test(text) &&
    /[A-Za-z0-9/=&#%+-]$/.test(text);
  return plain ? text : prose(text);
}

/**
 * What `<…>` makes a link: an absolute URI, a scheme and a colon and then nothing that ends the link.
 * Anything else in angle brackets is raw HTML (`<img>`) or plain text, so it is shown as code instead.
 */
const AUTOLINK = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/;

function location(entry: ReportEntry): string {
  const parts: string[] = [];
  if (entry.where) parts.push(codeSpan(entry.where));
  if (entry.url) parts.push(AUTOLINK.test(entry.url) ? `<${entry.url}>` : codeSpan(entry.url));
  return parts.length > 0 ? parts.join(" ") : "(no location)";
}

/**
 * The punch list: a summary table, then every group (severity, then code) with its count, its
 * message and the first ten places it was found. The message shown for a group is the first
 * entry's; an example whose own message differs says so.
 */
export function renderReportMarkdown(
  entries: readonly ReportEntry[],
  opts: { site: string },
): string {
  const summary = summarise(entries);
  const groups = group(entries);
  const lines: string[] = [`# Migration report: ${siteTitle(opts.site)}`, ""];

  if (entries.length === 0) {
    lines.push("No entries. Nothing was dropped or approximated.", "");
    return lines.join("\n");
  }

  lines.push(
    `${plural(summary.total, "entry", "entries")}: ${summary.bySeverity.error} error${summary.bySeverity.error === 1 ? "" : "s"}, ` +
      `${plural(summary.bySeverity.warn, "warning")}, ${summary.bySeverity.info} info.`,
    "",
    "## Summary",
    "",
    "| Severity | Entries | Codes |",
    "| --- | ---: | ---: |",
  );
  for (const severity of SEVERITIES) {
    const codes = groups.filter((g) => g.severity === severity).length;
    lines.push(`| ${severity} | ${summary.bySeverity[severity]} | ${codes} |`);
  }
  lines.push(`| total | ${summary.total} | ${Object.keys(summary.byCode).length} |`, "");

  for (const severity of SEVERITIES) {
    const ofSeverity = groups.filter((g) => g.severity === severity);
    if (ofSeverity.length === 0) continue;
    lines.push(`## ${severity} (${summary.bySeverity[severity]})`, "");
    for (const g of ofSeverity) {
      const first = g.entries[0]!;
      lines.push(`### ${codeSpan(g.code)} (${g.entries.length})`, "", prose(first.message), "");
      for (const entry of g.entries.slice(0, EXAMPLES_PER_GROUP)) {
        const own = entry.message !== first.message ? `: ${prose(entry.message)}` : "";
        lines.push(`- ${location(entry)}${own}`);
      }
      const more = g.entries.length - EXAMPLES_PER_GROUP;
      if (more > 0) lines.push(`- +${more} more`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

/**
 * Rewrites `value` into what `JSON.stringify` can print: `data` is free-form, and what lands in it
 * (a parsed PHP integer past 2^53 is a bigint, a block's attributes may hold a Map) must not be able
 * to throw away a whole report at the last step. `path` is the chain of objects being walked, so a
 * shared object that is not an ancestor is printed in full each time it appears and only a true cycle
 * becomes "[Circular]".
 */
function jsonSafe(value: unknown, path: Set<object>): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value;
  if (path.has(value)) return "[Circular]";
  path.add(value);
  try {
    if (value instanceof Error) return { name: value.name, message: value.message };
    if (value instanceof Map) {
      return Object.fromEntries([...value].map(([k, v]) => [String(k), jsonSafe(v, path)]));
    }
    if (value instanceof Set || Array.isArray(value))
      return [...value].map((v) => jsonSafe(v, path));
    const toJSON = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") return jsonSafe(toJSON.call(value), path);
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      const safe = jsonSafe(v, path);
      if (safe !== undefined) out[key] = safe;
    }
    return out;
  } finally {
    path.delete(value);
  }
}

/**
 * The machine-readable report: `{ summary, entries }`, with every entry, in the order it was added,
 * carrying everything it was given (the markdown view truncates; this one does not).
 */
export function renderReportJson(entries: readonly ReportEntry[]): string {
  return `${JSON.stringify(jsonSafe({ summary: summarise(entries), entries }, new Set()), null, 2)}\n`;
}
