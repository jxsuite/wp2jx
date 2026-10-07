/**
 * Which block namespaces the site's own plugin tree still registers (src/wp/block-registry.ts): the
 * second pilot's `drupalblock/…` blocks are in four pages and in no file of the plugins that are
 * installed, and the live pages print nothing for them.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSite } from "../helpers/ctx.ts";
import {
  findUnregisteredNamespaces,
  isUnregisteredBlock,
  setUnregisteredBlockNamespaces,
  unregisteredBlockNamespaces,
  usedBlockNamespaces,
} from "../../src/wp/block-registry.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A WordPress checkout of the files given, `wp-content`-relative. */
function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "wp2jx-registry-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, "wp-content", path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text);
  }
  return root;
}

describe("usedBlockNamespaces", () => {
  test("real: the namespaces the posts, templates and parts of anabaptistperspectives hold, core left out", async () => {
    const site = await loadSite("ap");
    const used = usedBlockNamespaces(site.model);
    expect(used).toContain("cwicly");
    expect(used).toContain("drupalblock");
    expect(used).toContain("lazyblock");
    expect(used).not.toContain("core");
  });

  test("a comment that spells the core namespace out is core's, and a block with no namespace in its comment is core's too", () => {
    const post = (content: string) => ({ content }) as never;
    const model = {
      posts: new Map([
        [1, post("<!-- wp:core/paragraph --><p>x</p><!-- /wp:core/paragraph -->")],
        [2, post('<!-- wp:paragraph --><!-- wp:acme/box {"a":1} /--><!-- wp:acme-two/thing /-->')],
      ]),
    } as never;
    expect([...usedBlockNamespaces(model)].sort()).toEqual(["acme", "acme-two"]);
  });
});

describe("findUnregisteredNamespaces", () => {
  test("a namespace that a plugin names in quotes is registered, in PHP, block.json and a built script", async () => {
    const root = checkout({
      "plugins/give/give.php": "<?php register_block_type( 'give/donation-form', [] );",
      "plugins/forms/block.json": '{ "name": "forms/guten-block" }',
      "plugins/forms/build/index.js": 'wp.blocks.registerBlockType("built/thing",{})',
      "plugins/esc/block.json": '{"name":"esc\\/slashed"}',
      "themes/t/functions.php": '<?php register_block_type( "themed/block" );',
      "plugins/quiet/readme.txt": "gone/widget is mentioned in a text file",
    });
    const gone = await findUnregisteredNamespaces(
      root,
      new Set(["give", "forms", "built", "esc", "themed", "gone", "drupalblock"]),
    );
    expect([...gone].sort()).toEqual(["drupalblock", "gone"]);
  });

  test("a name that only contains the namespace, or an address that goes through a folder of that name, is not a registration", async () => {
    const root = checkout({
      "plugins/a/a.php": "<?php $u = plugins_url('/give/assets'); $x = 'notgive/x'; // give/ here",
    });
    expect([...(await findUnregisteredNamespaces(root, new Set(["give"])))]).toEqual(["give"]);
  });

  test("scripts and PHP under node_modules and files over three megabytes are not read", async () => {
    const root = checkout({
      "plugins/a/node_modules/x/index.js": "'ghost/block'",
      "plugins/a/big.js": `'big/block'${" ".repeat(3_100_000)}`,
    });
    expect([...(await findUnregisteredNamespaces(root, new Set(["ghost", "big"])))].sort()).toEqual(
      ["big", "ghost"],
    );
  });

  test("a checkout with no plugins folder, or nothing to look for, claims nothing", async () => {
    const empty = checkout({ "themes/t/style.css": "x" });
    expect(await findUnregisteredNamespaces(empty, new Set(["a"]))).toEqual(new Set());
    const root = checkout({ "plugins/p/p.php": "<?php" });
    expect(await findUnregisteredNamespaces(root, new Set())).toEqual(new Set());
  });
});

describe("the namespaces kept beside a model", () => {
  test("a model has none until they are set; a block of one is unregistered, a core block never", async () => {
    const site = await loadSite("ap");
    const model = { ...site.model } as typeof site.model;
    expect(unregisteredBlockNamespaces(model).size).toBe(0);
    expect(isUnregisteredBlock(model, "drupalblock/x")).toBe(false);
    setUnregisteredBlockNamespaces(model, new Set(["drupalblock"]));
    expect(isUnregisteredBlock(model, "drupalblock/views-block-team-block-1")).toBe(true);
    expect(isUnregisteredBlock(model, "give/donation-form")).toBe(false);
    expect(isUnregisteredBlock(model, "core/paragraph")).toBe(false);
    expect(isUnregisteredBlock(model, null)).toBe(false);
  });
});
