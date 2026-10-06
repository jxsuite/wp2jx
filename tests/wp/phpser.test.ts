import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { unserialize as psUnserialize } from "php-serialize";
import {
  isSerialized,
  maybeUnserialize,
  PhpSerializeError,
  phpUnserialize,
} from "../../src/wp/phpser.ts";
import { fixtureDb } from "../helpers/fixture-db.ts";

// ── Real values ──────────────────────────────────────────────────────────────────────────────────
// Everything below that says "fixture" reads the committed rows through bun:sqlite directly, so the
// expectations do not pass through the code under test.

interface Sample {
  site: string;
  /** `postmeta:_menu_item_classes`, `option:active_plugins`, `post:acf-taxonomy`, `redirect:sources`… */
  src: string;
  /** The row's id, for messages and for picking one row out. */
  id: number | string;
  value: string;
}

async function loadSamples(
  site: string,
): Promise<{ db: Database; prefix: string; samples: Sample[] }> {
  const { path, prefix } = await fixtureDb(site);
  const db = new Database(path, { readonly: true });
  const samples: Sample[] = [];
  const take = (src: string, sql: string) => {
    for (const r of db.query(sql).all() as { id: number | string; k: string; v: unknown }[]) {
      if (typeof r.v === "string")
        samples.push({ site, src: `${src}:${r.k}`, id: r.id, value: r.v });
    }
  };
  take("postmeta", `select meta_id as id, meta_key as k, meta_value as v from ${prefix}postmeta`);
  take("termmeta", `select meta_id as id, meta_key as k, meta_value as v from ${prefix}termmeta`);
  take(
    "option",
    `select option_id as id, option_name as k, option_value as v from ${prefix}options`,
  );
  take("redirect", `select id, 'sources' as k, sources as v from ${prefix}rank_math_redirections`);
  take(
    "post",
    `select ID as id, post_type as k, post_content as v from ${prefix}posts where post_type like 'acf-%'`,
  );
  return { db, prefix, samples };
}

const fineline = await loadSamples("fineline");
const ap = await loadSamples("ap");
const allSamples = [...fineline.samples, ...ap.samples];

const bySource = (list: Sample[], src: string): Sample[] => list.filter((s) => s.src === src);
const byId = (list: Sample[], src: string, id: number | string): Sample => {
  const hit = list.find((s) => s.src === src && s.id === id);
  if (!hit) throw new Error(`fixture sample ${src} #${id} not found`);
  return hit;
};

/**
 * Values that are PHP-serialised by their shape alone: one structural pattern per type, with no
 * knowledge of is_serialized()'s own tests. Dotall, because strings and ACF definitions hold newlines.
 */
const SERIALIZED_SHAPE = /^(?:N;|[bid]:[-+0-9.eE]+;|s:\d+:".*";|a:\d+:\{.*\}|O:\d+:".*\})$/s;
const serializedLooking = allSamples.filter((s) => SERIALIZED_SHAPE.test(s.value.trim()));

/** One raw meta/option value, read straight from the SQLite file. */
function rawMeta(site: { db: Database; prefix: string }, postId: number, key: string): string {
  const row = site.db
    .query(
      `select meta_value as v from ${site.prefix}postmeta where post_id = ? and meta_key = ? order by meta_id`,
    )
    .get(postId, key) as { v: string } | null;
  if (!row) throw new Error(`no ${key} for post ${postId}`);
  return row.v;
}

function rawOption(site: { db: Database; prefix: string }, name: string): string {
  const row = site.db
    .query(`select option_value as v from ${site.prefix}options where option_name = ?`)
    .get(name) as { v: string } | null;
  if (!row) throw new Error(`no option ${name}`);
  return row.v;
}

// ── isSerialized ─────────────────────────────────────────────────────────────────────────────────

describe("isSerialized", () => {
  test("accepts every PHP type WordPress writes, and nothing else", () => {
    const yes = [
      "N;",
      "b:1;",
      "b:0;",
      "i:0;",
      "i:-42;",
      "d:0.5;",
      "d:1.0E+25;",
      's:0:"";',
      's:5:"hello";',
      "a:0:{}",
      'a:1:{i:0;s:1:"a";}',
      'O:8:"stdClass":0:{}',
      'E:11:"Suit:Hearts";',
    ];
    for (const v of yes) expect(isSerialized(v), v).toBe(true);
    const no = [
      "",
      "N",
      "n;",
      "a",
      "a:",
      "a:b",
      "a:{}",
      "x:1;",
      "i:5",
      "i:;",
      "s:5:hello",
      's:5:"hello"',
      "a:1:{",
      "hello world",
      '{"a":1}',
      "[1,2,3]",
      "true",
      "12",
    ];
    for (const v of no) expect(isSerialized(v), JSON.stringify(v)).toBe(false);
  });

  test("anything that is not a string is not serialized", () => {
    for (const v of [null, undefined, 5, true, {}, [], 5n, Symbol.iterator])
      expect(isSerialized(v)).toBe(false);
  });

  test("trims exactly what PHP trim() trims", () => {
    expect(isSerialized(" \t\r\nN;\n ")).toBe(true);
    expect(isSerialized("\0a:0:{}\x0b")).toBe(true);
    // String#trim would accept both of these; PHP's trim does not strip them.
    expect(isSerialized("\fN;")).toBe(false);
    expect(isSerialized("\u00a0a:0:{}")).toBe(false);
    expect(isSerialized("\ufeffa:0:{}")).toBe(false);
  });

  test("strict (the default) needs the value to end in ; or }, loose only needs one of them", () => {
    expect(isSerialized("a:0:{}trailing")).toBe(false);
    expect(isSerialized("a:0:{}trailing", false)).toBe(true);
    expect(isSerialized('s:5:"hello"')).toBe(false);
    expect(isSerialized("a:1:{")).toBe(false);
    expect(isSerialized("a:1:{", false)).toBe(false);
    // Loose mode needs the terminator past the header: `;` not before index 3, `}` not before index 4.
    expect(isSerialized("b:1;", false)).toBe(true);
    expect(isSerialized("i;1;x", false)).toBe(false);
    expect(isSerialized('s:3:"a";', false)).toBe(true);
    expect(isSerialized("s:3:abc", false)).toBe(false);
  });

  test("a string token must close its quote in strict mode", () => {
    expect(isSerialized('s:5:"hello;')).toBe(false);
    expect(isSerialized('s:5:"hello";')).toBe(true);
  });

  test("the scalar regexp is as lenient as WordPress's", () => {
    // WordPress only checks the character class, so these pass is_serialized() and fail to parse.
    expect(isSerialized("b:2;")).toBe(true);
    expect(isSerialized("i:1.5.5;")).toBe(true);
    expect(isSerialized("d:abc;")).toBe(false);
  });

  test("every serialized-looking fixture value is accepted, and every other one is refused", () => {
    expect(serializedLooking.length).toBeGreaterThan(1000);
    for (const s of serializedLooking)
      expect(isSerialized(s.value), `${s.site} ${s.src} #${s.id}`).toBe(true);
    const looking = new Set(serializedLooking);
    for (const s of allSamples) {
      if (looking.has(s)) continue;
      expect(isSerialized(s.value), `${s.site} ${s.src} #${s.id}`).toBe(false);
    }
  });

  test("JSON-valued Cwicly options and plain text are not serialized", () => {
    for (const name of [
      "cwicly_global_classes",
      "cwicly_global_styles",
      "cwicly_breakpoints_list",
      "siteurl",
      "blogname",
    ]) {
      const row = fineline.samples.find((s) => s.src === `option:${name}`);
      expect(row, name).toBeDefined();
      expect(isSerialized(row!.value), name).toBe(false);
    }
  });
});

// ── phpUnserialize: structure ────────────────────────────────────────────────────────────────────

describe("phpUnserialize", () => {
  test("scalars", () => {
    expect(phpUnserialize("N;")).toBeNull();
    expect(phpUnserialize("b:1;")).toBe(true);
    expect(phpUnserialize("b:0;")).toBe(false);
    expect(phpUnserialize("i:0;")).toBe(0);
    expect(phpUnserialize("i:-17;")).toBe(-17);
    expect(phpUnserialize("i:+17;")).toBe(17);
    expect(phpUnserialize("d:0.5;")).toBe(0.5);
    expect(phpUnserialize("d:-1.25E-3;")).toBe(-0.00125);
    expect(phpUnserialize("d:1.0E+25;")).toBe(1e25);
    expect(phpUnserialize("d:5;")).toBe(5);
    expect(phpUnserialize("d:.5;")).toBe(0.5);
    expect(phpUnserialize("d:5.;")).toBe(5);
    expect(phpUnserialize('s:0:"";')).toBe("");
    expect(phpUnserialize('s:5:"hello";')).toBe("hello");
  });

  test("float specials and signed zero", () => {
    expect(phpUnserialize("d:INF;")).toBe(Number.POSITIVE_INFINITY);
    expect(phpUnserialize("d:-INF;")).toBe(Number.NEGATIVE_INFINITY);
    expect(phpUnserialize("d:NAN;")).toBeNaN();
    expect(Object.is(phpUnserialize("d:-0;"), -0)).toBe(true);
    // PHP integers have no negative zero.
    expect(Object.is(phpUnserialize("i:-0;"), 0)).toBe(true);
  });

  test("integers beyond 2^53 stay exact", () => {
    expect(phpUnserialize("i:9007199254740991;")).toBe(9007199254740991);
    expect(phpUnserialize("i:9007199254740993;")).toBe(9007199254740993n);
    expect(phpUnserialize("i:9223372036854775807;")).toBe(9223372036854775807n);
    expect(phpUnserialize("i:-9223372036854775808;")).toBe(-9223372036854775808n);
  });

  test("integer array keys beyond 2^53 keep their exact digits as the property name", () => {
    // PHP array keys are 64-bit integers, and a numeric id of 16 to 19 digits (a social-network id, a
    // 64-bit hash) is a legal one that serializes as `i:<digits>;`. PHP 8.3 reads every value below.
    expect(phpUnserialize('a:1:{i:17895695668004550;a:1:{s:2:"id";s:1:"x";}}')).toEqual({
      "17895695668004550": { id: "x" },
    });
    expect(phpUnserialize("a:1:{i:9007199254740991;b:1;}")).toEqual({ "9007199254740991": true });
    expect(phpUnserialize("a:1:{i:9007199254740992;b:1;}")).toEqual({ "9007199254740992": true });
    expect(phpUnserialize("a:1:{i:9223372036854775807;b:1;}")).toEqual({
      "9223372036854775807": true,
    });
    expect(phpUnserialize("a:1:{i:-9223372036854775808;b:1;}")).toEqual({
      "-9223372036854775808": true,
    });
    // Spelled with a plus sign or leading zeros, the digits are still the canonical decimal text.
    expect(phpUnserialize("a:1:{i:+17895695668004550;b:1;}")).toEqual({
      "17895695668004550": true,
    });
    // Next to small keys; and the array is an object, never a list.
    const mixed = phpUnserialize('a:2:{i:9007199254740993;s:1:"a";i:0;s:1:"b";}');
    expect(mixed).toEqual({ "9007199254740993": "a", "0": "b" });
    expect(Array.isArray(mixed)).toBe(false);
    // The string spelling of the same key is the same key.
    expect(phpUnserialize('a:1:{s:17:"17895695668004550";b:1;}')).toEqual({
      "17895695668004550": true,
    });
  });

  test("a PHP array with keys 0..n-1 in order is a list, anything else an object", () => {
    expect(phpUnserialize("a:0:{}")).toEqual([]);
    expect(phpUnserialize('a:2:{i:0;s:1:"a";i:1;s:1:"b";}')).toEqual(["a", "b"]);
    expect(phpUnserialize('a:2:{i:1;s:1:"a";i:2;s:1:"b";}')).toEqual({ 1: "a", 2: "b" });
    expect(Array.isArray(phpUnserialize('a:2:{i:1;s:1:"a";i:2;s:1:"b";}'))).toBe(false);
    // array_is_list() is order sensitive.
    expect(Array.isArray(phpUnserialize('a:2:{i:1;s:1:"b";i:0;s:1:"a";}'))).toBe(false);
    expect(phpUnserialize('a:2:{s:1:"x";i:1;s:1:"y";i:2;}')).toEqual({ x: 1, y: 2 });
    expect(phpUnserialize("a:1:{i:-3;b:1;}")).toEqual({ "-3": true });
  });

  test("string keys PHP would turn into integers do so, others stay strings", () => {
    expect(phpUnserialize('a:2:{s:1:"0";s:1:"a";s:1:"1";s:1:"b";}')).toEqual(["a", "b"]);
    const kept = phpUnserialize('a:2:{s:2:"07";i:1;s:2:"+1";i:2;}') as Record<string, number>;
    expect(kept).toEqual({ "07": 1, "+1": 2 });
    expect(Array.isArray(kept)).toBe(false);
  });

  test("nesting", () => {
    const value = phpUnserialize(
      'a:3:{s:4:"name";s:3:"abc";s:4:"list";a:2:{i:0;i:1;i:1;a:1:{s:1:"k";N;}}s:4:"flag";b:1;}',
    );
    expect(value).toEqual({ name: "abc", list: [1, { k: null }], flag: true });
  });

  test("a __proto__ key stays an own property and does not touch the prototype", () => {
    const value = phpUnserialize('a:1:{s:9:"__proto__";a:1:{s:1:"x";i:1;}}') as Record<
      string,
      unknown
    >;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toEqual({ x: 1 });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  test("anything after the first complete value is ignored, as unserialize() does", () => {
    expect(phpUnserialize('s:2:"ab";garbage')).toBe("ab");
    expect(phpUnserialize("i:1;i:2;")).toBe(1);
  });

  describe("objects", () => {
    test("stdClass is a plain object, any other class keeps its name under __class", () => {
      expect(phpUnserialize('O:8:"stdClass":2:{s:1:"a";i:1;s:1:"b";s:1:"x";}')).toEqual({
        a: 1,
        b: "x",
      });
      const post = phpUnserialize(
        'O:7:"WP_Post":2:{s:2:"ID";i:7;s:10:"post_title";s:2:"Hi";}',
      ) as Record<string, unknown>;
      expect(post).toEqual({ __class: "WP_Post", ID: 7, post_title: "Hi" });
      expect(Object.keys(post)[0]).toBe("__class");
    });

    test("visibility prefixes are stripped from property names", () => {
      const value = phpUnserialize(
        'O:3:"Foo":3:{s:6:"public";i:1;s:12:"\0*\0protected";i:2;s:12:"\0Foo\0private";i:3;}',
      );
      expect(value).toEqual({ __class: "Foo", public: 1, protected: 2, private: 3 });
    });

    test("the class marker wins over a property of the same name", () => {
      expect(phpUnserialize('O:3:"Foo":1:{s:7:"__class";s:3:"bar";}')).toEqual({ __class: "Foo" });
    });

    test("namespaced class names", () => {
      expect(phpUnserialize('O:16:"Vendor\\Pkg\\Thing":0:{}')).toEqual({
        __class: "Vendor\\Pkg\\Thing",
      });
    });

    test("enums and Serializable payloads", () => {
      expect(phpUnserialize('E:11:"Suit:Hearts";')).toEqual({ __class: "Suit", name: "Hearts" });
      expect(phpUnserialize('C:11:"ArrayObject":6:{x:i:0;}')).toEqual({
        __class: "ArrayObject",
        __serialized: "x:i:0;",
      });
    });
  });

  describe("back-references", () => {
    test("r: points at an earlier object and shares it", () => {
      const value = phpUnserialize(
        'a:2:{i:0;O:8:"stdClass":1:{s:1:"a";i:1;}i:1;r:2;}',
      ) as unknown[];
      expect(value[1]).toBe(value[0]);
    });

    test("R: shares containers and copies scalars", () => {
      const value = phpUnserialize("a:3:{i:0;a:1:{i:0;i:5;}i:1;R:2;i:2;R:3;}") as unknown[];
      expect(value[1]).toBe(value[0]);
      expect(value[2]).toBe(5);
    });

    test("r: takes a slot of its own, R: does not, so later numbers keep lining up", () => {
      // slots: 1 the array, 2 the object, 3 the r: (a copy of the object), then R:3 points at that copy.
      const value = phpUnserialize('a:3:{i:0;O:8:"stdClass":0:{}i:1;r:2;i:2;R:3;}') as unknown[];
      expect(value[2]).toBe(value[0]);
      // slots: 1 the array, 2 and 3 the two strings; R:2 adds none, so R:3 is still "b".
      expect(phpUnserialize('a:4:{i:0;s:1:"a";i:1;s:1:"b";i:2;R:2;i:3;R:3;}')).toEqual([
        "a",
        "b",
        "a",
        "b",
      ]);
    });

    test("an object may contain a reference to itself", () => {
      const value = phpUnserialize('O:8:"stdClass":1:{s:4:"self";r:1;}') as { self: unknown };
      expect(value.self).toBe(value);
    });

    test("references to values that do not exist or are not finished are refused", () => {
      expect(() => phpUnserialize("a:1:{i:0;R:9;}")).toThrow(PhpSerializeError);
      expect(() => phpUnserialize("a:1:{i:0;R:1;}")).toThrow(/still being read/);
      expect(() => phpUnserialize("a:2:{i:0;i:1;i:1;r:2;}")).toThrow(/non-object/);
      expect(() => phpUnserialize("R:0;")).toThrow(PhpSerializeError);
    });
  });

  describe("PHP strings are byte strings", () => {
    test("lengths count UTF-8 bytes, not UTF-16 code units", () => {
      expect(phpUnserialize('s:5:"café";')).toBe("café"); // é is two bytes
      expect(phpUnserialize('s:3:"←";')).toBe("←"); // U+2190, three bytes
      expect(phpUnserialize('s:4:"🎨";')).toBe("🎨"); // astral, four bytes, two UTF-16 units
      expect(phpUnserialize('s:11:"🧑‍💼";')).toBe("🧑‍💼"); // two astral code points joined by a ZWJ
      expect(phpUnserialize('a:1:{s:4:"clé";s:3:"€";}')).toEqual({ clé: "€" }); // keys are byte strings too
    });

    test("a character count where PHP wants bytes is malformed", () => {
      expect(() => phpUnserialize('s:4:"café";')).toThrow(PhpSerializeError);
      expect(() => phpUnserialize('s:2:"🎨";')).toThrow(PhpSerializeError);
      expect(() => phpUnserialize('s:1:"←";')).toThrow(PhpSerializeError);
    });

    test("a string that merely contains the closing quote and semicolon is read by length", () => {
      expect(phpUnserialize('s:6:"a";b:1";')).toBe('a";b:1');
    });

    test("a leading byte order mark is part of the value", () => {
      expect(phpUnserialize('s:5:"\ufeffab";')).toBe("\ufeffab"); // three bytes plus two
    });

    test("fixture values with accents, dashes, symbols and emoji parse to the exact strings", () => {
      const taxonomy = byId(fineline.samples, "post:acf-taxonomy", 1560).value;
      const labels = (phpUnserialize(taxonomy) as { labels: Record<string, string> }).labels;
      expect(labels.back_to_items).toBe("← Go to project tags");

      const apTaxonomy = byId(ap.samples, "post:acf-taxonomy", 7371).value;
      expect(
        (phpUnserialize(apTaxonomy) as { labels: Record<string, string> }).labels.back_to_items,
      ).toBe("← Go to scripture");

      // Cyrillic file names: two bytes per letter.
      const cyr = phpUnserialize(
        byId(fineline.samples, "postmeta:_wp_attachment_metadata", 245).value,
      ) as {
        file: string;
        sizes: Record<string, { file: string }>;
      };
      expect(cyr.file).toBe("Дизайн-без-назви-10.png");
      expect(cyr.sizes.medium?.file).toBe("Дизайн-без-назви-10-300x125.png");

      // © in IPTC copyright text.
      const copyright = phpUnserialize(
        byId(fineline.samples, "postmeta:_wp_attachment_metadata", 930).value,
      ) as {
        image_meta: { copyright: string };
      };
      expect(copyright.image_meta.copyright).toBe("© 2023 christi stoner, all rights reserved.");

      // Emoji and a variation selector inside an uploaded file name.
      const emoji = phpUnserialize(
        byId(ap.samples, "postmeta:_wp_attachment_metadata", 70572).value,
      ) as { file: string };
      expect(emoji.file.endsWith("Jesus-and-Freedom-⛓️_💥.jpg")).toBe(true);

      // En dash and right single quotation mark in Rank Math redirect sources.
      const dash = phpUnserialize(byId(ap.samples, "redirect:sources", 629).value) as {
        pattern: string;
      }[];
      expect(dash[0]?.pattern).toBe("caring-those-who-serve-cross–culturally");
      const quote = phpUnserialize(byId(ap.samples, "redirect:sources", 642).value) as {
        pattern: string;
      }[];
      expect(quote[0]?.pattern).toBe("mourning-world’s-justice:-response-convictiderek-chauvin");

      // A ZWJ sequence among 100+ emoji in one option.
      const prompts = phpUnserialize(
        ap.samples.find((s) => s.src === "option:rank_math_content_ai_prompts")!.value,
      );
      expect(JSON.stringify(prompts)).toContain("🧑‍💼");
    });
  });

  describe("malformed input", () => {
    const bad: [string, string][] = [
      ["empty input", ""],
      ["unknown type", "x:1;"],
      ["a lone letter", "a"],
      ["string too short", 's:2:"abc";'],
      ["string too long", 's:9:"abc";'],
      ["string without its terminator", 's:3:"abc"'],
      ["string without its quotes", "s:3:abc;"],
      ["negative length", 's:-1:"";'],
      ["fewer elements than declared", 'a:2:{i:0;s:1:"a";}'],
      ["more elements than declared", 'a:1:{i:0;s:1:"a";i:1;s:1:"b";}'],
      ["missing closing brace", 'a:1:{i:0;s:1:"a";'],
      ["float key", "a:1:{d:1.5;i:1;}"],
      ["null key", "a:1:{N;i:1;}"],
      ["key without a value", "a:1:{i:0;}"],
      ["bad boolean", "b:2;"],
      ["bad integer", "i:1.5;"],
      ["bad float", "d:abc;"],
      ["unterminated integer", "i:12"],
      ["null without semicolon", "N"],
      ["object without a count", 'O:3:"Foo":{}'],
      ["truncated mid-array", 'a:1:{s:3:"key";'],
    ];
    for (const [label, input] of bad) {
      test(label, () => {
        expect(() => phpUnserialize(input)).toThrow(PhpSerializeError);
      });
    }

    test("the error says where parsing stopped", () => {
      try {
        phpUnserialize('a:2:{i:0;s:1:"a";i:1;s:5:"b";}');
        throw new Error("did not throw");
      } catch (error) {
        expect(error).toBeInstanceOf(PhpSerializeError);
        expect((error as PhpSerializeError).offset).toBeGreaterThan(10);
        expect((error as PhpSerializeError).message).toMatch(/at byte \d+/);
      }
    });

    test("absurd counts fail on the data they promise, not by allocating", () => {
      expect(() => phpUnserialize('a:999999999999:{i:0;s:1:"a";}')).toThrow(PhpSerializeError);
      expect(() => phpUnserialize('a:99999999:{i:0;s:1:"a";}')).toThrow(PhpSerializeError);
      expect(() => phpUnserialize('s:99999999999999999999:"x";')).toThrow(/out of range/);
    });

    test("nesting is bounded", () => {
      const depth = 700;
      const deep = `${"a:1:{i:0;".repeat(depth)}N;${"}".repeat(depth)}`;
      expect(() => phpUnserialize(deep)).toThrow(/nesting too deep/);
      const fine = `${"a:1:{i:0;".repeat(100)}N;${"}".repeat(100)}`;
      expect(phpUnserialize(fine)).toBeArray();
    });
  });
});

// ── maybeUnserialize ─────────────────────────────────────────────────────────────────────────────

describe("maybeUnserialize", () => {
  test("returns anything that is not serialized unchanged", () => {
    expect(maybeUnserialize("plain text")).toBe("plain text");
    expect(maybeUnserialize("")).toBe("");
    expect(maybeUnserialize('{"json":true}')).toBe('{"json":true}');
    expect(maybeUnserialize(null)).toBeNull();
    expect(maybeUnserialize(undefined)).toBeUndefined();
    expect(maybeUnserialize(12)).toBe(12);
    const obj = { a: 1 };
    expect(maybeUnserialize(obj)).toBe(obj);
  });

  test("unserializes after trimming, like maybe_unserialize()", () => {
    expect(maybeUnserialize('  a:1:{i:0;s:1:"a";}\n')).toEqual(["a"]);
    expect(maybeUnserialize("\0b:0;\0")).toBe(false);
    expect(maybeUnserialize("N;")).toBeNull();
  });

  test("an array keyed by a 64-bit id is read, and not mistaken for damage", () => {
    const value = 'a:1:{i:17895695668004550;a:1:{s:2:"id";s:1:"x";}}';
    expect(maybeUnserialize(value)).toEqual({ "17895695668004550": { id: "x" } });
    expect(maybeUnserialize(value)).not.toBe(value);
  });

  test("a serialized false is false, a failed parse is the input", () => {
    expect(maybeUnserialize("b:0;")).toBe(false);
    const damaged = 'a:1:{i:0;s:9:"short";}';
    expect(isSerialized(damaged)).toBe(true);
    expect(maybeUnserialize(damaged)).toBe(damaged);
  });

  test("damage of the kind a search-and-replace does is returned untouched", () => {
    // A real attachment value whose first string's length no longer matches (a domain was renamed).
    const real = byId(fineline.samples, "postmeta:_wp_attachment_metadata", 245).value;
    const damaged = real.replace("s:37:", "s:36:");
    expect(damaged).not.toBe(real);
    expect(isSerialized(damaged)).toBe(true);
    expect(() => phpUnserialize(damaged)).toThrow(PhpSerializeError);
    expect(maybeUnserialize(damaged)).toBe(damaged);
  });

  test("real values from the five places the brief names", () => {
    const plugins = maybeUnserialize(rawOption(fineline, "active_plugins")) as string[];
    expect(plugins).toHaveLength(34);
    expect(plugins[0]).toBe("wpcodebox2/wpcodebox2.php");
    expect(plugins[6]).toBe("cwicly/cwicly.php");
    expect(plugins.at(-1)).toBe("wpcodebox_functionality_plugin/plugin.php");
    expect(plugins.every((p) => p.endsWith(".php"))).toBe(true);

    const apPlugins = maybeUnserialize(rawOption(ap, "active_plugins")) as string[];
    expect(apPlugins).toHaveLength(52);
    expect(apPlugins).toContain("give/give.php");

    // Nav item 6069 ("Home"-style page link) and its custom-link siblings.
    expect(bySource(fineline.samples, "postmeta:_menu_item_classes")).toHaveLength(45);
    expect(maybeUnserialize(rawMeta(fineline, 6069, "_menu_item_classes"))).toEqual([
      "",
      "menu-item",
      "menu-item-type-post_type",
      "menu-item-object-page",
    ]);
    expect(maybeUnserialize(rawMeta(ap, 1299, "_menu_item_classes"))).toEqual([
      "",
      "menu-item",
      "menu-item-type-post_type",
      "menu-item-object-page",
      "current_page_parent",
    ]);

    const redirect = maybeUnserialize(byId(fineline.samples, "redirect:sources", 2).value);
    expect(redirect).toEqual([
      { ignore: "", pattern: "?page_id=482", comparison: "exact" },
      { ignore: "", pattern: "quote-page", comparison: "exact" },
    ]);

    const attachment = maybeUnserialize(rawMeta(fineline, 29, "_wp_attachment_metadata")) as {
      width: number;
      height: number;
      sizes: Record<string, { file: string; width: number; height: number; "mime-type": string }>;
      image_meta: { keywords: unknown[] };
    };
    expect(attachment.width).toBe(527);
    expect(attachment.height).toBe(252);
    expect(attachment.sizes.thumbnail).toMatchObject({
      width: 150,
      height: 72,
      "mime-type": "image/png",
    });
    expect(attachment.image_meta.keywords).toEqual([]);

    const projectType = maybeUnserialize(
      byId(fineline.samples, "post:acf-post-type", 1077).value,
    ) as Record<string, unknown> & { labels: Record<string, unknown> };
    expect(projectType.post_type).toBe("project");
    expect(projectType.advanced_configuration).toBe(true);
    expect(projectType.labels.name).toBe("Projects");
    expect(Object.keys(projectType)).toHaveLength(37);
    expect(Object.keys(projectType.labels)).toHaveLength(33);
  });
});

// ── The whole fixture corpus ─────────────────────────────────────────────────────────────────────

describe("every serialized value in both fixture sites", () => {
  const parsed = serializedLooking.map((s) => ({ s, value: maybeUnserialize(s.value) }));

  test("parses; no value falls back to the raw string", () => {
    expect(parsed.length).toBe(serializedLooking.length);
    const failed = parsed.filter((p) => p.value === p.s.value);
    expect(failed.map((p) => `${p.s.site} ${p.s.src} #${p.s.id}`)).toEqual([]);
  });

  test("agrees with the independent php-serialize package", () => {
    const disagreements: string[] = [];
    let compared = 0;
    for (const { s, value } of parsed) {
      let theirs: unknown;
      try {
        theirs = psUnserialize(s.value.trim(), {}, { strict: false });
      } catch {
        continue; // it cannot read this one (see the header of src/wp/phpser.ts); nothing to compare
      }
      compared++;
      if (!sameCanon(value, fromPhpSerialize(theirs)))
        disagreements.push(`${s.site} ${s.src} #${s.id}`);
    }
    expect(compared).toBeGreaterThan(serializedLooking.length - 5);
    expect(disagreements).toEqual([]);
  });

  test("serializing the result again reproduces the original text byte for byte", () => {
    // Not checked byte for byte, because a JS value cannot carry them back: PHP floats that print
    // like integers (`d:1;`) and non-list arrays with integer keys (a JS object lists those in
    // ascending order, PHP in insertion order). Those are checked for parse(serialize(parse(x))) =
    // parse(x) instead.
    let exact = 0;
    for (const { s, value } of parsed) {
      if (/O:\d+:"/.test(s.value)) continue; // objects come back as arrays; the PHP comparison below covers them
      const again = reserialize(value);
      if (/(?:^|[;{])d:[^;]*;/.test(s.value) || hasIntegerKeyedObject(value)) {
        expect(sameCanon(phpUnserialize(again), value), `${s.site} ${s.src} #${s.id}`).toBe(true);
        continue;
      }
      expect(again, `${s.site} ${s.src} #${s.id}`).toBe(s.value.trim());
      exact++;
    }
    expect(exact).toBeGreaterThan(serializedLooking.length * 0.9);
  });

  test("the fixtures cover every width of UTF-8", () => {
    const seen = new Set<number>();
    for (const s of serializedLooking) {
      for (const ch of s.value) {
        const cp = ch.codePointAt(0)!;
        if (cp > 0x7f) seen.add(cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4);
      }
    }
    expect([...seen].sort()).toEqual([2, 3, 4]);
  });
});

// ── Differential check against PHP itself, when it is installed ──────────────────────────────────

/** A `php` that has `array_is_list` (8.1+), which the canonicalising script below uses. */
function findPhp(): string | null {
  const binary = Bun.which("php");
  if (!binary) return null;
  const probe = Bun.spawnSync([binary, "-r", "echo PHP_VERSION_ID >= 80100 ? 'yes' : 'no';"]);
  return probe.exitCode === 0 && probe.stdout.toString() === "yes" ? binary : null;
}

const php = findPhp();

describe.skipIf(!php)("against PHP's own unserialize()", () => {
  // Canonicalises PHP's result into the shape phpUnserialize promises, so the comparison is exact.
  const script = `<?php
    function canon($v) {
      if (is_null($v) || is_bool($v) || is_string($v)) return $v;
      if (is_int($v)) return abs($v) > 9007199254740991 ? ['__int' => (string)$v] : $v;
      if (is_float($v)) {
        if (is_nan($v)) return ['__float' => 'NAN'];
        if (is_infinite($v)) return ['__float' => $v > 0 ? 'INF' : '-INF'];
        return $v;
      }
      if (is_array($v)) {
        if (array_is_list($v)) return array_map('canon', $v);
        $o = new stdClass;
        foreach ($v as $k => $x) $o->{(string)$k} = canon($x);
        return $o;
      }
      if (is_object($v)) {
        $name = get_class($v);
        $arr = (array)$v;
        if ($name === '__PHP_Incomplete_Class') { $name = $arr['__PHP_Incomplete_Class_Name']; unset($arr['__PHP_Incomplete_Class_Name']); }
        $o = new stdClass;
        foreach ($arr as $k => $x) {
          $k = (string)$k;
          if ($k !== '' && $k[0] === "\\0") $k = substr($k, strpos($k, "\\0", 1) + 1);
          $o->{$k} = canon($x);
        }
        if ($name !== 'stdClass') $o->__class = $name;
        return $o;
      }
      return null;
    }
    $flags = JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_INVALID_UTF8_SUBSTITUTE;
    $in = fopen('php://stdin', 'r');
    while (($line = fgets($in)) !== false) {
      $s = trim(base64_decode(trim($line)), " \\t\\n\\r\\0\\x0B");
      $r = @unserialize($s);
      $failed = ($r === false && $s !== 'b:0;');
      echo json_encode($failed ? ['ok' => false] : ['ok' => true, 'value' => canon($r)], $flags), "\\n";
    }
  `;

  test("the same value, for every serialized fixture value and a set of hand-made edge cases", () => {
    const edge = [
      "N;",
      "b:1;",
      "i:-5;",
      "d:0.1;",
      "d:1.0E+25;",
      "d:-0;",
      "d:INF;",
      "d:-INF;",
      's:3:"a;b";',
      'a:2:{i:0;s:3:"✓";i:1;s:4:"🎨";}',
      'a:3:{i:3;s:1:"a";i:1;s:1:"b";s:1:"7";s:1:"c";}',
      // 64-bit integer keys, past 2^53 (a numeric id used as an array key).
      'a:1:{i:17895695668004550;a:1:{s:2:"id";s:1:"x";}}',
      "a:1:{i:9223372036854775807;b:1;}",
      "a:1:{i:-9223372036854775808;b:1;}",
      'a:2:{i:9007199254740993;s:1:"a";i:5;s:1:"b";}',
      'a:2:{i:0;O:8:"stdClass":1:{s:1:"a";i:1;}i:1;r:2;}',
      'O:3:"Foo":3:{s:1:"a";i:1;s:4:"\0*\0b";i:2;s:6:"\0Foo\0c";i:3;}',
      'O:8:"stdClass":0:{}',
      "i:9223372036854775807;",
      // Malformed: PHP fails and so must we.
      's:9:"abc";',
      'a:2:{i:0;s:1:"a";}',
      "d:abc;",
    ];
    const inputs = [...serializedLooking.map((s) => s.value.trim()), ...edge];
    const proc = Bun.spawnSync(
      [php!, "-d", "memory_limit=2G", "-r", script.replace(/^<\?php/, "")],
      {
        stdin: new TextEncoder().encode(
          inputs.map((v) => `${Buffer.from(v).toString("base64")}\n`).join(""),
        ),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(proc.stderr.toString()).toBe("");
    const results = proc.stdout
      .toString()
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l) as { ok: boolean; value?: unknown });
    expect(results).toHaveLength(inputs.length);

    const mismatches: string[] = [];
    inputs.forEach((input, i) => {
      const expected = results[i]!;
      let mine: { ok: true; value: unknown } | { ok: false };
      try {
        mine = { ok: true, value: phpUnserialize(input) };
      } catch {
        mine = { ok: false };
      }
      if (mine.ok !== expected.ok) {
        mismatches.push(`parse/fail disagreement on ${input.slice(0, 60)}`);
      } else if (mine.ok && !sameCanon(mine.value, expected.value)) {
        mismatches.push(`value disagreement on ${input.slice(0, 60)}`);
      }
    });
    expect(mismatches).toEqual([]);
  });
});

// ── Helpers: independent reference code for the tests only ──────────────────────────────────────

/** php-serialize hands objects back as incomplete-class instances; reshape them to our convention. */
function fromPhpSerialize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromPhpSerialize);
  if (v !== null && typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const name = rec.__PHP_Incomplete_Class_Name;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      if (key !== "__PHP_Incomplete_Class_Name") out[key] = fromPhpSerialize(rec[key]);
    }
    if (typeof name === "string" && name !== "stdClass") out.__class = name;
    return out;
  }
  return v;
}

function canonical(v: unknown): unknown {
  if (typeof v === "bigint") return { __int: v.toString() };
  if (typeof v === "number" && !Number.isFinite(v))
    return { __float: Number.isNaN(v) ? "NAN" : v > 0 ? "INF" : "-INF" };
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v).sort())
      out[key] = canonical((v as Record<string, unknown>)[key]);
    return out;
  }
  return v;
}

function sameCanon(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

const INTEGER_KEY = /^(?:0|-?[1-9][0-9]*)$/;

function hasIntegerKeyedObject(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasIntegerKeyedObject);
  if (v === null || typeof v !== "object") return false;
  return Object.entries(v).some(([k, x]) => INTEGER_KEY.test(k) || hasIntegerKeyedObject(x));
}

/** PHP's serialize() for what phpUnserialize produces (floats print as JS prints them). */
function reserialize(v: unknown): string {
  if (v === null) return "N;";
  if (typeof v === "boolean") return `b:${v ? 1 : 0};`;
  if (typeof v === "bigint") return `i:${v};`;
  if (typeof v === "number") return Number.isInteger(v) ? `i:${v};` : `d:${v};`;
  if (typeof v === "string") return `s:${Buffer.byteLength(v)}:"${v}";`;
  if (Array.isArray(v))
    return `a:${v.length}:{${v.map((x, i) => `i:${i};${reserialize(x)}`).join("")}}`;
  const entries = Object.entries(v as Record<string, unknown>);
  const body = entries
    .map(
      ([k, x]) =>
        `${INTEGER_KEY.test(k) ? `i:${k};` : `s:${Buffer.byteLength(k)}:"${k}";`}${reserialize(x)}`,
    )
    .join("");
  return `a:${entries.length}:{${body}}`;
}
