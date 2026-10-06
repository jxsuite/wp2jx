/**
 * The text-diff toolkit: normalisation, word similarity, the order-preserving alignment and the
 * near-miss pairing the text comparison reports `changed` blocks from.
 */
import { describe, expect, test } from "bun:test";
import {
  align,
  dice,
  lcsPairs,
  normalizeText,
  wordCount,
  wordSimilarity,
} from "../../src/verify/diff.ts";

describe("normalizeText", () => {
  test("typographic punctuation and spaces fold to ASCII", () => {
    expect(normalizeText("It’s “quoted” – and …  done")).toBe('It\'s "quoted" - and ... done');
  });

  test("whitespace of every kind collapses, zero-width characters vanish into spaces, ends trim", () => {
    expect(normalizeText("  a \n\t b​c  ")).toBe("a b c");
    expect(normalizeText("")).toBe("");
  });

  test("a word the two renderings spell differently only by typography compares equal", () => {
    expect(normalizeText("Fine Line’s “best”")).toBe(normalizeText('Fine Line\'s "best"'));
  });
});

describe("dice and word similarity", () => {
  test("the same words in another order are the same", () => {
    expect(dice("a b c", "c b a")).toBe(1);
  });

  test("disjoint texts share nothing; an empty text is only like another empty one", () => {
    expect(dice("a b", "c d")).toBe(0);
    expect(dice("", "")).toBe(1);
    expect(dice("a", "")).toBe(0);
    expect(dice("", "a")).toBe(0);
  });

  test("repeats count: two of a word against one is a partial match", () => {
    expect(dice("a a", "a")).toBeCloseTo(2 / 3, 5);
  });

  test("a page-level similarity over lists of blocks, and a word count", () => {
    expect(wordSimilarity(["one two", "three"], ["three", "one two"])).toBe(1);
    expect(wordSimilarity(["one two"], ["one three"])).toBe(0.5);
    expect(wordCount(["one two", "three", ""])).toBe(3);
  });
});

describe("lcsPairs", () => {
  test("pairs equal items in order, ignoring what only one side has", () => {
    const pairs = lcsPairs(["a", "b", "c", "d"], ["a", "x", "c", "d", "y"]);
    expect(pairs).toEqual([
      [0, 0],
      [2, 2],
      [3, 3],
    ]);
  });

  test("finds the longest common subsequence in the middle, not just the ends", () => {
    const a = ["s", "a", "b", "c", "d", "e"];
    const b = ["s", "b", "a", "c", "e", "d", "e"];
    const pairs = lcsPairs(a, b);
    expect(pairs.length).toBe(5);
    for (const [i, j] of pairs) expect(a[i]).toBe(b[j]);
    for (let k = 1; k < pairs.length; k++) {
      expect((pairs[k] as [number, number])[0]).toBeGreaterThan(
        (pairs[k - 1] as [number, number])[0],
      );
      expect((pairs[k] as [number, number])[1]).toBeGreaterThan(
        (pairs[k - 1] as [number, number])[1],
      );
    }
  });

  test("a list that moves its first item to the end still keeps the other three in order", () => {
    // An in-order greedy match would pair only the first item; the longest subsequence is three.
    expect(lcsPairs(["a", "b", "c", "d"], ["b", "c", "d", "a"])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
    ]);
  });

  test("identical, disjoint and empty inputs", () => {
    expect(lcsPairs(["a", "b"], ["a", "b"])).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(lcsPairs(["a"], ["b"])).toEqual([]);
    expect(lcsPairs([], ["a"])).toEqual([]);
    expect(lcsPairs(["a"], [])).toEqual([]);
  });

  test("a list too big for the table still matches in order", () => {
    const a = Array.from({ length: 2600 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 2600 }, (_, i) => (i % 2 === 0 ? `a${i}` : `b${i}`));
    const pairs = lcsPairs(a, b);
    expect(pairs.length).toBe(1300);
    for (const [i, j] of pairs) expect(a[i]).toBe(b[j]);
  });
});

describe("align", () => {
  test("separates equal, near-miss, and one-sided blocks", () => {
    const live = ["Welcome", "We paint barns and houses in Lancaster", "Call us", "Only live"];
    const local = [
      "Welcome",
      "We paint barns and homes in Lancaster",
      "Call us",
      "Only local words here",
    ];
    const a = align(live, local);
    expect(a.same).toEqual([
      [0, 0],
      [2, 2],
    ]);
    expect(a.changed).toEqual([{ a: 1, b: 1, similarity: expect.any(Number) }]);
    expect(a.changed[0]?.similarity).toBeGreaterThan(0.7);
    expect(a.onlyA).toEqual([3]);
    expect(a.onlyB).toEqual([3]);
  });

  test("the best partner wins, and each is used once", () => {
    const a = align(["red green blue", "red green"], ["red green", "red green blue"], 0.5);
    // LCS keeps one pair as equal; the other two are near misses of each other or one-sided, never double-counted.
    const used = [...a.same.map((p) => p[1]), ...a.changed.map((c) => c.b), ...a.onlyB];
    expect(new Set(used).size).toBe(used.length);
  });

  test("below the minimum similarity, a pair is missing plus extra, not changed", () => {
    const a = align(["alpha beta gamma"], ["alpha zeta eta"], 0.8);
    expect(a.changed).toEqual([]);
    expect(a.onlyA).toEqual([0]);
    expect(a.onlyB).toEqual([0]);
  });

  test("two lists that share nothing and are huge are not paired", () => {
    const a = Array.from({ length: 700 }, (_, i) => `x${i} y`);
    const b = Array.from({ length: 700 }, (_, i) => `z${i} y`);
    const r = align(a, b, 0.1);
    expect(r.changed).toEqual([]);
    expect(r.onlyA.length).toBe(700);
    expect(r.onlyB.length).toBe(700);
  });
});
