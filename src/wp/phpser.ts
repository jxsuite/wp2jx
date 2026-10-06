/**
 * PHP `serialize()` / `unserialize()` for the values WordPress keeps in its tables: option values,
 * post and term meta, ACF definitions, Rank Math redirect sources.
 *
 * This is a hand-written parser rather than a wrapper over `php-serialize`. That package was run
 * against PHP 8.3's own `unserialize()` on the 13,062 serialised strings among the 129,254 option,
 * meta and post values of two live WordPress databases, and it is not good enough as it stands:
 * its `isSerialized` disagrees with WordPress's `is_serialized` on 307 values in its default mode
 * (every array that contains no `"`, `a:0:{}` included) and on 13,059 in strict mode; its
 * `unserialize` throws on two values PHP reads (an `r:` back-reference, an object whose properties
 * have integer keys), has no `R:` or `E:`, throws a `SyntaxError` on `d:INF;` and `d:NAN;`, returns
 * `d:-0;` as `0n`, throws on any class by default and, in its lenient mode, returns `stdClass` and
 * every other object as a `__PHP_Incomplete_Class` instance rather than a plain object. Mending
 * that means post-processing every result and shipping our own `isSerialized` anyway, and the
 * format is small, so the parser is ours: read PHP-serialised values through {@link maybeUnserialize}
 * and not through a package with those faults. (The tests keep `php-serialize` as an independent
 * cross-check.)
 *
 * Semantics follow PHP, because the reference behaviour is "what WordPress would have read":
 * - Strings are BYTE strings. `s:5:"café";` is five bytes (`caf` + two for `é`), so the input is
 *   encoded to UTF-8 once and every length is counted on that, never on UTF-16 code units.
 * - A PHP array whose keys are exactly 0..n-1 in order (`array_is_list`) becomes a JS array; any
 *   other array becomes a plain object keyed by the PHP key. Keys that PHP would normalise to
 *   integers (`"7"`, not `"07"`) are treated as integers, as `unserialize()` does. Note that JS
 *   enumerates integer-like keys in ascending order, so the insertion order of a non-list array with
 *   integer keys is not recoverable from the object.
 * - Objects become plain objects with the class name under `__class`, except `stdClass`, which is
 *   indistinguishable from an array-as-object. Visibility prefixes are stripped from property names.
 *   A `C:` (Serializable) object keeps its opaque payload under `__serialized`; an `E:` enum case
 *   becomes `{ __class, name }`.
 * - Integers outside the safe JS range stay exact as `bigint`; everything else is a `number`. An
 *   array key outside that range (PHP keys are 64-bit) is a property name, so it is its exact
 *   decimal text.
 * - Like `unserialize()`, anything after the first complete value is ignored.
 */

/** Thrown by {@link phpUnserialize}; `offset` is the byte position the parser had reached. */
export class PhpSerializeError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (at byte ${offset})`);
    this.name = "PhpSerializeError";
    this.offset = offset;
  }
}

// ── isSerialized: WordPress's is_serialized(), statement for statement ─────────────────────────

// PHP's trim() strips exactly these; JS String#trim also takes \f, NBSP, the BOM and Unicode spaces,
// and a value that merely starts with U+00A0 is not "serialized" to WordPress.
const isPhpSpace = (c: number): boolean =>
  c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x00 || c === 0x0b;

function phpTrim(s: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && isPhpSpace(s.charCodeAt(start))) start++;
  while (end > start && isPhpSpace(s.charCodeAt(end - 1))) end--;
  return start === 0 && end === s.length ? s : s.slice(start, end);
}

const HEADED = { s: /^s:[0-9]+:/, a: /^a:[0-9]+:/, O: /^O:[0-9]+:/, E: /^E:[0-9]+:/ } as const;
const SCALAR_STRICT = /^[bid]:[0-9.E+-]+;$/;
const SCALAR_LOOSE = /^[bid]:[0-9.E+-]+;/;

/**
 * WordPress's `is_serialized( $data, $strict )`. Anything that is not a string is not serialized.
 * `strict` (the WordPress default) requires the value to end in `;` or `}`; the loose form only
 * requires one of them to exist somewhere after the header.
 */
export function isSerialized(value: unknown, strict = true): boolean {
  if (typeof value !== "string") return false;
  const data = phpTrim(value);
  if (data === "N;") return true;
  // A positive answer needs at least `x:0;`-length input; PHP counts bytes, but a string shorter
  // than four UTF-16 units cannot reach a match in any branch below either way.
  if (data.length < 4) return false;
  if (data[1] !== ":") return false;
  if (strict) {
    const last = data[data.length - 1];
    if (last !== ";" && last !== "}") return false;
  } else {
    const semicolon = data.indexOf(";");
    const brace = data.indexOf("}");
    if (semicolon === -1 && brace === -1) return false;
    if (semicolon !== -1 && semicolon < 3) return false;
    if (brace !== -1 && brace < 4) return false;
  }
  switch (data[0]) {
    case "s":
      if (strict) {
        if (data[data.length - 2] !== '"') return false;
      } else if (!data.includes('"')) {
        return false;
      }
      return HEADED.s.test(data);
    case "a":
      return HEADED.a.test(data);
    case "O":
      return HEADED.O.test(data);
    case "E":
      return HEADED.E.test(data);
    case "b":
    case "i":
    case "d":
      return (strict ? SCALAR_STRICT : SCALAR_LOOSE).test(data);
    default:
      return false;
  }
}

// ── phpUnserialize ──────────────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();
// `ignoreBOM: true` keeps a U+FEFF that is part of a string value instead of silently eating it.
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** PHP's default `unserialize_max_depth` is 4096; the recursive descent here is shallower on purpose. */
const MAX_DEPTH = 512;

const CH_COLON = 0x3a;
const CH_SEMI = 0x3b;
const CH_QUOTE = 0x22;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;
const CH_0 = 0x30;
const CH_9 = 0x39;

const INT_TEXT = /^[+-]?[0-9]+$/;
const FLOAT_TEXT = /^[+-]?(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
/** PHP's array-key normalisation: canonical decimal integers become integer keys. */
const INT_KEY = /^(?:0|-?[1-9][0-9]*)$/;

/** Assigns `value` as an own property, including the names (`__proto__`) plain assignment would swallow. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } else {
    target[key] = value;
  }
}

/** `\0*\0name` (protected) and `\0Class\0name` (private) both mean `name` to anything outside PHP. */
function plainPropertyName(key: string): string {
  if (key.charCodeAt(0) !== 0) return key;
  const end = key.indexOf("\0", 1);
  return end === -1 ? key : key.slice(end + 1);
}

class Parser {
  private pos = 0;
  /**
   * PHP's back-reference table: every value except an `R:` gets the next number, in the order it
   * starts (containers before their children); array keys and property names do not count.
   * `undefined` marks a value that is still being read.
   */
  private readonly slots: unknown[] = [];

  constructor(private readonly bytes: Uint8Array) {}

  parse(): unknown {
    return this.value(0);
  }

  private fail(message: string, at: number = this.pos): never {
    throw new PhpSerializeError(message, at);
  }

  private expect(byte: number, what: string): void {
    if (this.bytes[this.pos] !== byte) this.fail(`expected ${what}`);
    this.pos++;
  }

  /** The ASCII text up to (not including) `terminator`, which is consumed. Scalars are short. */
  private text(terminator: number, what: string): string {
    const { bytes } = this;
    const start = this.pos;
    const limit = Math.min(bytes.length, start + 400);
    let end = start;
    while (end < limit && bytes[end] !== terminator) end++;
    if (end >= limit) this.fail(`unterminated ${what}`, start);
    this.pos = end + 1;
    return decoder.decode(bytes.subarray(start, end));
  }

  /** `[0-9]+` followed by `terminator`: a length or element count. */
  private count(terminator: number, what: string): number {
    const { bytes } = this;
    const start = this.pos;
    let n = 0;
    while (this.pos < bytes.length) {
      const c = bytes[this.pos]!;
      if (c < CH_0 || c > CH_9) break;
      n = n * 10 + (c - CH_0);
      if (n > Number.MAX_SAFE_INTEGER) this.fail(`${what} out of range`, start);
      this.pos++;
    }
    if (this.pos === start) this.fail(`expected ${what}`, start);
    this.expect(terminator, terminator === CH_COLON ? "':'" : "';'");
    return n;
  }

  /** `<len>:"<bytes>"` with the opening quote's `:` already consumed by the caller's header. */
  private quoted(): string {
    const length = this.count(CH_COLON, "string length");
    this.expect(CH_QUOTE, "'\"'");
    const start = this.pos;
    const end = start + length;
    if (end > this.bytes.length) this.fail("string runs past the end of the input", start);
    this.pos = end;
    this.expect(CH_QUOTE, "closing '\"' (the declared byte length does not match)");
    return decoder.decode(this.bytes.subarray(start, end));
  }

  private value(depth: number): unknown {
    if (depth > MAX_DEPTH) this.fail("nesting too deep");
    const { bytes } = this;
    const at = this.pos;
    const type = bytes[at];
    if (type === undefined) this.fail("unexpected end of input");
    const letter = String.fromCharCode(type);
    this.pos++;

    if (letter === "N") {
      this.expect(CH_SEMI, "';'");
      this.slots.push(null);
      return null;
    }
    if (letter === "R" || letter === "r") {
      this.expect(CH_COLON, "':'");
      const n = this.count(CH_SEMI, "reference number");
      const target = this.slots[n - 1];
      if (n < 1 || n > this.slots.length)
        this.fail(`reference to a value that does not exist (#${n})`, at);
      if (target === undefined)
        this.fail("reference to a value that is still being read is not supported", at);
      if (letter === "r") {
        if (target === null || typeof target !== "object" || Array.isArray(target)) {
          this.fail("object back-reference to a non-object", at);
        }
        this.slots.push(target);
      }
      return target;
    }

    this.expect(CH_COLON, "':'");
    const slot = this.slots.length;
    this.slots.push(undefined);
    let result: unknown;
    switch (letter) {
      case "b": {
        const v = bytes[this.pos];
        if (v !== 0x30 && v !== 0x31) this.fail("expected 0 or 1");
        this.pos++;
        this.expect(CH_SEMI, "';'");
        result = v === 0x31;
        break;
      }
      case "i": {
        const text = this.text(CH_SEMI, "integer");
        if (!INT_TEXT.test(text)) this.fail(`bad integer '${text}'`, at);
        const n = Number(text);
        result = Number.isSafeInteger(n) ? (n === 0 ? 0 : n) : BigInt(text);
        break;
      }
      case "d": {
        const text = this.text(CH_SEMI, "float");
        if (text === "NAN") result = Number.NaN;
        else if (text === "INF") result = Number.POSITIVE_INFINITY;
        else if (text === "-INF") result = Number.NEGATIVE_INFINITY;
        else if (FLOAT_TEXT.test(text)) result = Number(text);
        else this.fail(`bad float '${text}'`, at);
        break;
      }
      case "s": {
        result = this.quoted();
        this.expect(CH_SEMI, "';'");
        break;
      }
      case "a": {
        result = this.array(depth);
        break;
      }
      case "O": {
        result = this.object(depth, slot);
        break;
      }
      case "C": {
        const name = this.quoted();
        this.expect(CH_COLON, "':'");
        const length = this.count(CH_COLON, "payload length");
        this.expect(CH_LBRACE, "'{'");
        const start = this.pos;
        if (start + length > bytes.length)
          this.fail("payload runs past the end of the input", start);
        this.pos = start + length;
        this.expect(CH_RBRACE, "'}'");
        result = {
          __class: name,
          __serialized: decoder.decode(bytes.subarray(start, start + length)),
        };
        break;
      }
      case "E": {
        const label = this.quoted();
        this.expect(CH_SEMI, "';'");
        const colon = label.indexOf(":");
        if (colon < 1) this.fail(`bad enum case '${label}'`, at);
        result = { __class: label.slice(0, colon), name: label.slice(colon + 1) };
        break;
      }
      default:
        this.fail(`unsupported type '${letter}'`, at);
    }
    this.slots[slot] = result;
    return result;
  }

  /** An array key: `i:<n>;` or `s:<len>:"<bytes>";`. PHP rejects every other type here. */
  private key(): string | number {
    const at = this.pos;
    const letter = this.bytes[this.pos];
    this.pos++;
    this.expect(CH_COLON, "':'");
    if (letter === 0x69) {
      const text = this.text(CH_SEMI, "integer key");
      if (!INT_TEXT.test(text)) this.fail(`bad integer key '${text}'`, at);
      const n = Number(text);
      // PHP keys are 64-bit integers, so a numeric id past 2^53 is legal. The key is only ever a
      // property name here, and its exact decimal digits are what a number cannot hold.
      if (!Number.isSafeInteger(n)) return BigInt(text).toString();
      return n === 0 ? 0 : n;
    }
    if (letter === 0x73) {
      const s = this.quoted();
      this.expect(CH_SEMI, "';'");
      return INT_KEY.test(s) && Number.isSafeInteger(Number(s)) ? Number(s) : s;
    }
    return this.fail("array keys must be integers or strings", at);
  }

  private array(depth: number): unknown {
    const length = this.count(CH_COLON, "element count");
    this.expect(CH_LBRACE, "'{'");
    const keys: (string | number)[] = [];
    const values: unknown[] = [];
    let isList = true;
    for (let i = 0; i < length; i++) {
      const key = this.key();
      if (key !== i) isList = false;
      keys.push(key);
      values.push(this.value(depth + 1));
    }
    this.expect(CH_RBRACE, "'}' closing the array");
    if (isList) return values;
    const out: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i++) setOwn(out, String(keys[i]), values[i]);
    return out;
  }

  private object(depth: number, slot: number): unknown {
    const className = this.quoted();
    this.expect(CH_COLON, "':'");
    const length = this.count(CH_COLON, "property count");
    this.expect(CH_LBRACE, "'{'");
    const isStd = className === "stdClass";
    const out: Record<string, unknown> = isStd ? {} : { __class: className };
    // Registered up front so a later `r:` can point at an object that contains it.
    this.slots[slot] = out;
    for (let i = 0; i < length; i++) {
      const key = this.key();
      setOwn(out, plainPropertyName(String(key)), this.value(depth + 1));
    }
    this.expect(CH_RBRACE, "'}' closing the object");
    // The class marker wins over a (pathological) property of the same name.
    if (!isStd) out.__class = className;
    return out;
  }
}

/**
 * Parses one PHP-serialised value. Throws {@link PhpSerializeError} on malformed input: a declared
 * length that does not match, an element count that runs out, an unknown type tag, truncation.
 * The input is used as given; trim it first when it comes from a column (see {@link maybeUnserialize}).
 */
export function phpUnserialize(input: string): unknown {
  return new Parser(encoder.encode(input)).parse();
}

/**
 * WordPress's `maybe_unserialize()`: the parsed value when `value` is serialized, otherwise the
 * input unchanged. A value that looks serialized but does not parse (the classic damage from a
 * search-and-replace that changed string lengths) is also returned unchanged rather than thrown, so
 * callers can tell it from `false` and from `null`.
 */
export function maybeUnserialize(value: unknown): unknown {
  if (!isSerialized(value)) return value;
  try {
    return phpUnserialize(phpTrim(value as string));
  } catch {
    return value;
  }
}
