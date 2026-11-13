/**
 * The named formulas a converted project carries, and the calls that use them.
 *
 * A binding that is a value read from a path, perhaps passed through a named formula, perhaps with a
 * fallback (`${state.formatDate(state.entry.data.date, {"dateStyle":"long"})}`,
 * `${!state.notEmpty($map.item.data.premium)}`) is one Jx Studio opens as a named field with a
 * format, not as code. So where the meaning is exactly the same, the converter writes a formula
 * call on a plain path instead of a lambda (docs/bindings.md, section 5.1).
 *
 * The definitions are Jx's own packaged formulas (`@jxsuite/formulas`: `formatDate`, `notEmpty`,
 * `orBlank`, `escapeHtml`), copied here because that package is copy-in by design: a project holds
 * the formulas it calls in its own `state`. They are written into **`project.json`'s `state`**, once
 * each, and only the ones a document of the project calls ({@link formulasUsed}). The project is the
 * right home: the build evaluates the call, nothing is left that reads the formula, and Jx drops an
 * inherited project entry a page no longer reads, so the page still ships no JavaScript. The same
 * entry in a page's own `state` would make the page a client page. A Jx with jxsuite/jx#642 gives
 * every component of the project the same formulas (they are pure and read nothing of the project),
 * so a component calls them as a page does.
 */

/** A named formula as `project.json`'s `state` holds it. */
export interface FormulaEntry {
  $description: string;
  parameters: readonly Record<string, unknown>[];
  $expression: unknown;
}

const arg = (name: string): { $ref: string } => ({ $ref: `$args/${name}` });

/** `(value ?? "") === ""`: the value is missing or empty. */
const blank = (name: string): unknown => ({
  operator: "===",
  target: { operator: "??", target: arg(name), value: "" },
  value: "",
});

const replaceAll = (target: unknown, from: string, to: string): unknown => ({
  operator: "replaceAll",
  target,
  value: [from, to],
});

const pick = (values: readonly string[]): { enum: readonly string[] } => ({ enum: values });

/** The formulas the converter may call, by the name a binding calls them (`state.<name>(…)`). */
export const FORMULAS = {
  formatDate: {
    $description:
      "Format a date or timestamp in the page's locale (Intl.DateTimeFormat, UTC unless options name a timeZone); an empty string for a missing or empty value instead of a thrown RangeError.",
    parameters: [
      {
        name: "value",
        type: { text: "string | number | null", type: ["string", "number", "null"] },
        description: "An ISO 8601 date string or a timestamp in milliseconds.",
      },
      {
        name: "options",
        optional: true,
        description: "How to write it: a preset pair (dateStyle, timeStyle) or individual fields.",
        type: {
          text: "Intl.DateTimeFormatOptions",
          type: "object",
          properties: {
            dateStyle: pick(["full", "long", "medium", "short"]),
            timeStyle: pick(["full", "long", "medium", "short"]),
            weekday: pick(["long", "short", "narrow"]),
            era: pick(["long", "short", "narrow"]),
            year: pick(["numeric", "2-digit"]),
            month: pick(["numeric", "2-digit", "long", "short", "narrow"]),
            day: pick(["numeric", "2-digit"]),
            hour: pick(["numeric", "2-digit"]),
            minute: pick(["numeric", "2-digit"]),
            second: pick(["numeric", "2-digit"]),
            hour12: { type: "boolean" },
            timeZoneName: pick(["short", "long"]),
            timeZone: { type: "string" },
          },
        },
      },
    ],
    $expression: {
      operator: "?:",
      target: blank("value"),
      value: "",
      initial: {
        operator: "call",
        target: { $ref: "window#/Intl/formatDate" },
        value: [arg("value"), null, arg("options")],
      },
    },
  },
  notEmpty: {
    $description:
      'True when a value has content: false for a missing value, "", "0", 0, false, NaN and an empty array (the test PHP\'s empty() makes), true for anything else.',
    parameters: [{ name: "value", type: { text: "unknown" } }],
    $expression: {
      operator: "&&",
      target: {
        operator: "&&",
        target: { operator: "!", target: { operator: "!", target: arg("value") } },
        value: { operator: "!==", target: arg("value"), value: "0" },
      },
      value: {
        operator: "!",
        target: {
          operator: "&&",
          target: {
            operator: "call",
            target: { $ref: "window#/Array/isArray" },
            value: [arg("value")],
          },
          value: { operator: "===", target: arg("value/length"), value: 0 },
        },
      },
    },
  },
  orBlank: {
    $description:
      'The value as given, or an empty string when it is missing, "0", 0 or false (what a PHP template prints for a field it reads as unset).',
    parameters: [{ name: "value", type: { text: "unknown" } }],
    $expression: {
      operator: "?:",
      target: {
        operator: "||",
        target: {
          operator: "||",
          target: { operator: "===", target: arg("value"), value: "0" },
          value: { operator: "===", target: arg("value"), value: 0 },
        },
        value: { operator: "===", target: arg("value"), value: false },
      },
      value: "",
      initial: { operator: "??", target: arg("value"), value: "" },
    },
  },
  escapeHtml: {
    $description:
      "Text made safe to place in markup or an attribute value: &, <, >, \" and ' become character references; a missing value gives an empty string.",
    parameters: [{ name: "text", type: { text: "string | null", type: ["string", "null"] } }],
    $expression: replaceAll(
      replaceAll(
        replaceAll(
          replaceAll(
            replaceAll(
              {
                operator: "+",
                target: "",
                value: { operator: "??", target: arg("text"), value: "" },
              },
              "&",
              "&amp;",
            ),
            "<",
            "&lt;",
          ),
          ">",
          "&gt;",
        ),
        '"',
        "&quot;",
      ),
      "'",
      "&#39;",
    ),
  },
} as const satisfies Record<string, FormulaEntry>;

export type FormulaName = keyof typeof FORMULAS;

const NAMES = Object.keys(FORMULAS) as FormulaName[];

// ── Paths and calls ──────────────────────────────────────────────────────────────────────────────

const ROOTS = "state|item|index|\\$map|\\$page|\\$site";
const IDENT = "[A-Za-z_$][\\w$]*";
/** A key in brackets: a number, or a string in either quote with no quote, backslash or bracket of its own left bare. */
const KEY = `(?:\\d+|'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")`;
const PATH = new RegExp(`^(?:${ROOTS})(?:\\??\\.${IDENT}|(?:\\?\\.)?\\[${KEY}\\])*$`);
const CALL = new RegExp(`^state\\.(${IDENT})\\(`);

/**
 * Whether an expression is a plain path: one of the roots a template has (`state`, `$map`, `item`,
 * `index`, `$page`, `$site`) followed by member reads (`.name`, `?.name`, `['key']`, `?.['key']`).
 */
export function isPath(expr: string): boolean {
  return PATH.test(expr);
}

/** The end of the argument list that opens at `open` (the index of its `(`), or -1: strings are skipped. */
function closing(expr: string, open: number): number {
  let depth = 0;
  for (let i = open; i < expr.length; i++) {
    const c = expr[i] as string;
    if (c === "'" || c === '"') {
      for (i++; i < expr.length && expr[i] !== c; i++) if (expr[i] === "\\") i++;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Whether an expression is a value Studio reads as a field: a plain path, or a call of one of the
 * converter's formulas on such a value (`state.escapeHtml(state.orBlank($map.item.data.x))`). Only
 * the calls this module writes are recognised, which is all the converter needs to know.
 */
export function isPipe(expr: string): boolean {
  if (isPath(expr)) return true;
  const call = CALL.exec(expr);
  if (!call || !Object.hasOwn(FORMULAS, call[1] as string)) return false;
  const open = call[0].length - 1;
  const end = closing(expr, open);
  if (end !== expr.length - 1) return false;
  const inside = expr.slice(open + 1, end);
  // The input is everything before the first argument, and an argument is JSON: it starts at `, `.
  const comma = splitInput(inside);
  return isPipe(inside.slice(0, comma));
}

/** Where the first argument after the input starts in a call's argument text, or its length. */
function splitInput(inside: string): number {
  let depth = 0;
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i] as string;
    if (c === "'" || c === '"') {
      for (i++; i < inside.length && inside[i] !== c; i++) if (inside[i] === "\\") i++;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) return i;
  }
  return inside.length;
}

/**
 * `expr` when it is a pipe, and the path of `path ?? ''` (a formula that reads a missing value as
 * empty needs no coalescing before it); `undefined` for any other expression.
 */
export function pipeOf(expr: string): string | undefined {
  if (isPipe(expr)) return expr;
  const bare = expr.replace(/ \?\? ''$/, "");
  return bare !== expr && isPipe(bare) ? bare : undefined;
}

/**
 * `<value> || <fallback>`: the value, or the fallback when there is none. A value read from a path
 * takes no parentheses and no `?? ''` before `||` (a missing value is falsy either way), and without
 * them the binding is a field with a fallback, which Studio reads; any other expression keeps its
 * parentheses. `fallback` is JavaScript source (`false`, a quoted string); a single-quoted string is
 * written as {@link tagString} spells the same text, which is the literal Jx's dynamic tag reads.
 * Anything else (`b || c || ''`, a chain of fallbacks) is left as given, and the binding is then a
 * custom expression to Studio: its grammar takes one literal fallback.
 */
export function orFallback(expr: string, fallback: string): string {
  const text = singleQuotedText(fallback);
  return `${pipeOf(expr) ?? `(${expr})`} || ${text === undefined ? fallback : tagString(text)}`;
}

/**
 * A text as the single-quoted literal Jx Studio writes for a fallback it is typed into
 * (`fallbackLiteral` in its dynamic tags): what `JSON.stringify` writes between the quotes, with a
 * double quote bare and a single quote escaped, so a tag Studio reads and writes back is the text
 * it was read from. Only JSON's escapes and `\'` are used, which is what the tag reader takes in a
 * single-quoted string; a control character other than a line break is one (`\t`), not the raw
 * character, which no JSON string may hold. A brace, `$`, a backtick and the line separators are
 * `\uXXXX` besides (rule 13, as {@link jsonArg}): JSON escapes too, so the reader still reads the
 * literal, and a build that counts braces without reading strings still finds the end of the `${…}`.
 */
export function tagString(text: string): string {
  const inner = JSON.stringify(text)
    .slice(1, -1)
    .replaceAll('\\"', '"')
    .replaceAll("'", "\\'")
    .replaceAll(UNSAFE_IN_STRING, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `'${inner}'`;
}

/** What a single escape character stands for in a string literal, for the ones the tag reader takes. */
const ESCAPED: Readonly<Record<string, string>> = {
  "'": "'",
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * The text of a single-quoted JavaScript string literal that uses only escapes JSON has (and `\'`),
 * or `undefined` for anything else, which is then left as it is written.
 */
function singleQuotedText(source: string): string | undefined {
  if (source.length < 2 || !source.startsWith("'") || !source.endsWith("'")) return undefined;
  let out = "";
  for (let i = 1; i < source.length - 1; i++) {
    const c = source[i] as string;
    if (c === "'") return undefined;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = source[++i];
    if (e === undefined || i === source.length - 1) return undefined;
    if (e === "u") {
      const hex = source.slice(i + 1, i + 5);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else {
      const v = ESCAPED[e];
      if (v === undefined) return undefined;
      out += v;
    }
  }
  return out;
}

/**
 * `!<value>`: true when there is no value. A value read from a path is negated bare (`path ?? ''` is
 * false exactly when the path's value is), which Studio reads as "is empty"; any other expression
 * keeps its parentheses.
 */
export function notOf(expr: string): string {
  const pipe = pipeOf(expr);
  return pipe === undefined ? `!(${expr})` : `!${pipe}`;
}

/** Built from text so that this file holds no raw line separator. */
const UNSAFE_IN_STRING = new RegExp("[{}$`\\u2028\\u2029]", "g");

/**
 * A JSON value as an argument of a call inside a binding. It is JSON (which is JavaScript too), with
 * the characters the build's reading of a `${…}` trips over spelled as `\uXXXX` inside its strings: a
 * brace (the build counts them without reading strings, rule 13), `$` and a backtick (the string is a
 * template literal to it), and the two line separators.
 */
export function jsonArg(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(value).replaceAll(
      UNSAFE_IN_STRING,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  }
  if (Array.isArray(value)) return `[${value.map((v) => jsonArg(v)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${jsonArg(k)}:${jsonArg(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** `state.<name>(<input>, <args as JSON>…)`: the call, in the form Studio prints it. */
export function formulaCall(name: FormulaName, input: string, ...args: unknown[]): string {
  return `state.${name}(${[input, ...args.map((a) => jsonArg(a))].join(", ")})`;
}

// ── The same formulas as JavaScript ──────────────────────────────────────────────────────────────

/** The locale Jx's own date helper falls back to where a state has no page (`DEFAULT_FORMAT_LOCALE`). */
const DEFAULT_LOCALE = "en-US";

/** A language tag that can stand in JavaScript source between quotes as it is. */
const LOCALE_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

const formatDateJs = (locale: string): string =>
  `(v, o) => (v ?? '') === '' ? '' : new Intl.DateTimeFormat(state.$page?.locale || '${locale}', {timeZone: 'UTC', ...o}).format(new Date(v))`;

/**
 * Each formula as a JavaScript function of the same arguments, with the same result for every value
 * (tests/formulas.test.ts evaluates the two side by side with Jx's own interpreter). It is what a call
 * is written as where no formula can be called ({@link lowerFormulas}), and what a call means when
 * the converter itself evaluates a binding ({@link formulaFunctions}). `formatDate` reads the page's
 * locale as Jx's helper does (`state.$page.locale`, else `en-US`), and UTC unless the options name a
 * zone.
 */
export const FORMULA_JS: Readonly<Record<FormulaName, string>> = {
  formatDate: formatDateJs(DEFAULT_LOCALE),
  notEmpty: "(v) => !!v && v !== '0' && !(Array.isArray(v) && v.length === 0)",
  orBlank: "(v) => v === '0' || v === 0 || v === false ? '' : v ?? ''",
  escapeHtml:
    "(t) => ('' + (t ?? '')).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('\"', '&quot;').replaceAll(\"'\", '&#39;')",
};

/**
 * {@link FORMULA_JS} for a project whose pages are in `language`. Only `formatDate` differs: where
 * the state it is written into has no page (a component's state is its own), it formats in the
 * project's language, which is the locale every page of the project has, instead of `en-US`. Without
 * that a date in a component of an `en-GB` site would print as an American one, which is also what
 * the formula itself prints in a component (it has no `$page.locale` to read there), so such a date
 * stays written out where a component could call the formula (`settleFormulas`).
 */
export function formulaJs(name: FormulaName, language: string = DEFAULT_LOCALE): string {
  const locale = language.trim().replace("_", "-");
  return name === "formatDate" && LOCALE_TAG.test(locale) ? formatDateJs(locale) : FORMULA_JS[name];
}

/** A formula function: what `state.<name>` is to a binding. */
export type FormulaFunction = (...args: unknown[]) => unknown;

/**
 * The formulas as functions, for evaluating a binding outside the build: the `state` a binding that
 * calls one needs. `state` is what the functions themselves read (`formatDate` reads the page's
 * locale from it); the default has no page, so dates are written in `en-US`.
 */
export function formulaFunctions(state: object = {}): Record<FormulaName, FormulaFunction> {
  const out = {} as Record<FormulaName, FormulaFunction>;
  for (const name of NAMES) {
    out[name] = new Function("state", `return (${FORMULA_JS[name]});`)(state) as FormulaFunction;
  }
  return out;
}

/**
 * The text with every call of the formulas in `names` written as its JavaScript instead:
 * `state.escapeHtml(state.label)` becomes `((t) => …)(state.label)`. The value is the same; the
 * binding is code again and no longer a field with a format. This is for the places a formula cannot
 * be called from, or would mean something else in: a component of a Jx that gives a component none of
 * the project's formulas (before jxsuite/jx#642), a component whose own `state` has an entry of the
 * formula's name, a date in a component of a site whose language is not Jx's default, and a Jx that
 * does not yet evaluate the formula at build or keep a page that calls one free of JavaScript.
 * `language` is the project's ({@link formulaJs}).
 */
export function lowerFormulas(
  text: string,
  names: ReadonlySet<FormulaName>,
  language?: string,
): string {
  let out = "";
  let at = 0;
  const call = new RegExp(`\\bstate\\.(${NAMES.join("|")})\\(`, "g");
  for (let m = call.exec(text); m !== null; m = call.exec(text)) {
    const name = m[1] as FormulaName;
    if (!names.has(name)) continue;
    const open = m.index + m[0].length - 1;
    const end = closing(text, open);
    // A call that never closes is not one this module wrote: it is left as it stands.
    if (end < 0) continue;
    const inside = lowerFormulas(text.slice(open + 1, end), names, language);
    out += `${text.slice(at, m.index)}(${formulaJs(name, language)})(${inside})`;
    at = end + 1;
    call.lastIndex = at;
  }
  return out + text.slice(at);
}

/** {@link lowerFormulas} over every string of a JSON value (a document), keys left alone. */
export function lowerFormulasIn<T>(
  value: T,
  names: ReadonlySet<FormulaName>,
  language?: string,
): T {
  if (typeof value === "string") return lowerFormulas(value, names, language) as T;
  if (Array.isArray(value)) return value.map((v) => lowerFormulasIn(v, names, language)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, lowerFormulasIn(v, names, language)]),
    ) as T;
  }
  return value;
}

/** Every formula: what {@link lowerFormulas} takes to write all of them out. */
export const ALL_FORMULAS: ReadonlySet<FormulaName> = new Set(NAMES);

// ── Dates Intl writes exactly ────────────────────────────────────────────────────────────────────

/**
 * PHP date formats that `Intl.DateTimeFormat` writes exactly in one locale: the whole format, not its
 * letters (Intl writes a pattern per locale, so `F j, Y` is `en-US`'s long date and nothing else's).
 */
export const INTL_FORMATS: Readonly<Record<string, [string, Intl.DateTimeFormatOptions]>> = {
  "F j, Y": ["en-US", { year: "numeric", month: "long", day: "numeric" }],
  "M j, Y": ["en-US", { year: "numeric", month: "short", day: "numeric" }],
  "m/d/Y": ["en-US", { year: "numeric", month: "2-digit", day: "2-digit" }],
  "j F Y": ["en-GB", { year: "numeric", month: "long", day: "numeric" }],
  "d/m/Y": ["en-GB", { year: "numeric", month: "2-digit", day: "2-digit" }],
};

/**
 * The options that make `state.formatDate` print what PHP's `date($format)` prints in `zone`, or
 * `undefined` when it cannot: the format is not one Intl writes whole, or the pages are not in the
 * locale that writes it. The formula formats in the page's locale, which is the project's `lang`
 * (the site's `language`), so `F j, Y` is a formula call on a site in `en-US` and stays an expression
 * of its own on any other.
 */
export function intlDateOptions(
  format: string,
  language: string,
  zone: string,
): Record<string, string> | undefined {
  const known = INTL_FORMATS[format];
  if (known === undefined || known[0] !== language.trim().replace("_", "-")) return undefined;
  return { ...(known[1] as Record<string, string>), timeZone: zone };
}

// ── The registrar ────────────────────────────────────────────────────────────────────────────────

/**
 * The formulas the texts call, in a fixed order. A call is `state.<name>(`, wherever it stands: in a
 * binding of its own, inside another call, or in the item of a computed list (where the loop's row
 * has another name but `state` is still the page's).
 */
export function formulasUsed(texts: Iterable<string>): FormulaName[] {
  const found = new Set<FormulaName>();
  for (const text of texts) {
    if (found.size === NAMES.length) break;
    for (const name of NAMES) {
      if (!found.has(name) && text.includes(`state.${name}(`)) found.add(name);
    }
  }
  return NAMES.filter((name) => found.has(name));
}

/** The `state` of `project.json` for the documents of a project: an entry per formula they call, or `undefined` for none. */
export function formulaState(texts: Iterable<string>): Record<string, FormulaEntry> | undefined {
  const used = formulasUsed(texts);
  if (used.length === 0) return undefined;
  return Object.fromEntries(used.map((name) => [name, FORMULAS[name]]));
}
