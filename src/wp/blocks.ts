/**
 * Gutenberg block markup → the {@link WpBlock} tree the converters work on.
 *
 * The parsing itself is WordPress's own reference tokenizer (`@wordpress/block-serialization-default-parser`),
 * so a post is read exactly as WordPress reads it. This module only normalises its output to the
 * contract in `types.ts` and adds the traversal helpers every converter needs.
 */
import { parse } from "@wordpress/block-serialization-default-parser";
import type { WpBlock } from "../types.ts";

type RawBlock = ReturnType<typeof parse>[number];

const WHITESPACE_ONLY = /^\s*$/;

/**
 * Parses `post_content` into blocks.
 *
 * - `attrs` is always an object. The reference parser answers `null` when a block comment's JSON does
 *   not parse, and the block itself is still a block, so it keeps its place with no attributes.
 * - Freeform (classic) HTML between blocks is a block with `name: null`; the whitespace WordPress
 *   leaves between two block comments is not content and is dropped.
 * - Both `innerHTML` and `innerContent` are the parser's own, so `innerContent.filter(c => c === null)`
 *   lines up one to one with `innerBlocks`.
 *
 * Built iteratively: a pathologically deep document costs memory, not a stack overflow.
 */
export function parseBlocks(content: string): WpBlock[] {
  const roots: WpBlock[] = [];
  // Pre-order with an explicit stack: children are pushed in reverse so they pop in document order,
  // and each is appended to its parent's `innerBlocks` as it pops.
  const pending: { raw: RawBlock; into: WpBlock[] }[] = [];
  const raws = parse(content);
  for (let i = raws.length - 1; i >= 0; i--) pending.push({ raw: raws[i]!, into: roots });
  while (pending.length > 0) {
    const { raw, into } = pending.pop()!;
    if (raw.blockName === null && WHITESPACE_ONLY.test(raw.innerHTML)) continue;
    const block: WpBlock = {
      name: raw.blockName,
      attrs: raw.attrs ?? {},
      innerBlocks: [],
      innerHTML: raw.innerHTML,
      innerContent: raw.innerContent,
    };
    into.push(block);
    for (let i = raw.innerBlocks.length - 1; i >= 0; i--) {
      pending.push({ raw: raw.innerBlocks[i]!, into: block.innerBlocks });
    }
  }
  return roots;
}

/**
 * Visits every block depth first, parents before their children and siblings in document order.
 * `parent` is the enclosing block, or `null` for a top-level one.
 */
export function walkBlocks(
  blocks: readonly WpBlock[],
  visitor: (block: WpBlock, parent: WpBlock | null) => void,
): void {
  const pending: { block: WpBlock; parent: WpBlock | null }[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) pending.push({ block: blocks[i]!, parent: null });
  while (pending.length > 0) {
    const { block, parent } = pending.pop()!;
    visitor(block, parent);
    for (let i = block.innerBlocks.length - 1; i >= 0; i--) {
      pending.push({ block: block.innerBlocks[i]!, parent: block });
    }
  }
}

/** How many blocks of each name the tree holds, nested ones included. Freeform HTML has no name and is not counted. */
export function countBlocks(blocks: readonly WpBlock[]): Map<string, number> {
  const counts = new Map<string, number>();
  walkBlocks(blocks, (block) => {
    if (block.name !== null) counts.set(block.name, (counts.get(block.name) ?? 0) + 1);
  });
  return counts;
}
