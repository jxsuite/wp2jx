/**
 * The small text-diff toolkit the comparison is built from: normalisation, word similarity and an
 * order-preserving alignment of two lists (the longest common subsequence), with the leftovers
 * between the matched anchors paired up when they are near-misses of each other.
 */

const QUOTE_SINGLE = new Set([0x2018, 0x2019, 0x201a, 0x201b, 0x2032]);
const QUOTE_DOUBLE = new Set([0x201c, 0x201d, 0x201e, 0x201f, 0x2033]);
// No-break space, zero-width space, zero-width (non-)joiner, byte order mark.
const BLANKS = new Set([0xa0, 0x200b, 0x200c, 0x200d, 0xfeff]);

/** Typographic punctuation to ASCII, whitespace collapsed: two renderings of one sentence compare equal. */
export function normalizeText(text: string): string {
  let out = "";
  for (const ch of text.normalize("NFC")) {
    const code = ch.codePointAt(0) as number;
    if (QUOTE_SINGLE.has(code)) out += "'";
    else if (QUOTE_DOUBLE.has(code)) out += '"';
    else if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212) out += "-";
    else if (code === 0x2026) out += "...";
    else if (BLANKS.has(code) || /\s/.test(ch)) out += " ";
    else out += ch;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

const words = (text: string): string[] => (text === "" ? [] : text.split(" "));

function counts(list: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of list) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

/** Sørensen–Dice over the multisets of words: 1 for the same words in any order, 0 for none shared. */
export function dice(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (wa.length === 0 && wb.length === 0) return 1;
  if (wa.length === 0 || wb.length === 0) return 0;
  const ca = counts(wa);
  let common = 0;
  for (const [word, n] of counts(wb)) common += Math.min(n, ca.get(word) ?? 0);
  return (2 * common) / (wa.length + wb.length);
}

/** The words two texts share, as a share of the words of both (the page-level text similarity). */
export function wordSimilarity(a: readonly string[], b: readonly string[]): number {
  return dice(a.join(" "), b.join(" "));
}

/** Words in a list of normalised blocks. */
export function wordCount(blocks: readonly string[]): number {
  let n = 0;
  for (const block of blocks) n += words(block).length;
  return n;
}

/**
 * Index pairs `[i, j]` with `a[i] === b[j]`, increasing in both, as many as possible.
 * Common ends are stripped first (most pages differ in the middle); the middle uses the classic
 * table when it is small enough and an in-order greedy match when it is not.
 */
export function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  const pairs: [number, number][] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    pairs.push([start, start]);
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  const tail: [number, number][] = [];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
    tail.push([endA, endB]);
  }
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0) {
    if (n * m <= 6_000_000) {
      const width = m + 1;
      const table = new Uint32Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          table[i * width + j] =
            a[start + i] === b[start + j]
              ? (table[(i + 1) * width + j + 1] as number) + 1
              : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
        }
      }
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[start + i] === b[start + j]) {
          pairs.push([start + i, start + j]);
          i += 1;
          j += 1;
        } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
          i += 1;
        } else {
          j += 1;
        }
      }
    } else {
      // Too big for the table: match each item to its next occurrence ahead, in order.
      const where = new Map<string, number[]>();
      for (let j = start; j < endB; j++) {
        const list = where.get(b[j] as string);
        if (list === undefined) where.set(b[j] as string, [j]);
        else list.push(j);
      }
      let floor = start;
      for (let i = start; i < endA; i++) {
        const list = where.get(a[i] as string);
        if (list === undefined) continue;
        const j = list.find((candidate) => candidate >= floor);
        if (j === undefined) continue;
        pairs.push([i, j]);
        floor = j + 1;
      }
    }
  }
  return [...pairs, ...tail.reverse()];
}

export interface Alignment {
  /** Pairs that are equal. */
  same: [number, number][];
  /** Near misses: unmatched on both sides but alike enough to read as an edit. */
  changed: { a: number; b: number; similarity: number }[];
  /** Only in `a`. */
  onlyA: number[];
  /** Only in `b`. */
  onlyB: number[];
}

/**
 * Align two lists of strings. Between two matched anchors, the leftovers of each side are paired
 * best-first by word similarity (at least `minSimilarity`); what stays unpaired is only on one side.
 */
export function align(a: readonly string[], b: readonly string[], minSimilarity = 0.5): Alignment {
  const same = lcsPairs(a, b);
  const result: Alignment = { same, changed: [], onlyA: [], onlyB: [] };
  let i = 0;
  let j = 0;
  const gap = (endA: number, endB: number): void => {
    const left: number[] = [];
    const right: number[] = [];
    for (let x = i; x < endA; x++) left.push(x);
    for (let y = j; y < endB; y++) right.push(y);
    // A huge gap is two pages that share nothing: pairing it would cost more than it tells.
    if (left.length * right.length > 400_000) {
      result.onlyA.push(...left);
      result.onlyB.push(...right);
      return;
    }
    const taken = new Set<number>();
    for (const x of left) {
      let best = -1;
      let bestScore = minSimilarity;
      for (const y of right) {
        if (taken.has(y)) continue;
        const score = dice(a[x] as string, b[y] as string);
        if (score >= bestScore) {
          best = y;
          bestScore = score;
        }
      }
      if (best === -1) result.onlyA.push(x);
      else {
        taken.add(best);
        result.changed.push({ a: x, b: best, similarity: Math.round(bestScore * 1000) / 1000 });
      }
    }
    for (const y of right) if (!taken.has(y)) result.onlyB.push(y);
  };
  for (const [x, y] of same) {
    gap(x, y);
    i = x + 1;
    j = y + 1;
  }
  gap(a.length, b.length);
  return result;
}
