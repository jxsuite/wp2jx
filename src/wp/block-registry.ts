/**
 * Which blocks the site can still render. A dynamic block saves no markup: WordPress asks the plugin
 * that registered it for the output, on every request. A block no plugin or theme of the site registers
 * any more (a Drupal import left `drupalblock/views-block-team-block-1` in four pages of the second
 * pilot; its plugin is gone) prints nothing, saved markup apart, and the live page shows nothing there.
 * The tree of the site (`--plugin-from` a checkout) says it: a block's namespace that no PHP, JSON or
 * script file of `wp-content/plugins` and `themes` ever names in quotes is nobody's.
 *
 * It is the namespace that is searched, not the whole name: a plugin may make its names
 * (`views-block-<name>`), and a namespace that is named anywhere keeps its blocks' placeholder, which
 * is the safe side of a wrong guess.
 */
import { Glob } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WpModel } from "../types.ts";

const EMPTY: ReadonlySet<string> = new Set();
const UNREGISTERED = new WeakMap<WpModel, ReadonlySet<string>>();

/** The block namespaces nothing in the site's plugin tree registers, kept beside the model they were found for. */
export const unregisteredBlockNamespaces = (model: WpModel): ReadonlySet<string> =>
  UNREGISTERED.get(model) ?? EMPTY;

export function setUnregisteredBlockNamespaces(model: WpModel, found: ReadonlySet<string>): void {
  UNREGISTERED.set(model, found);
}

/** Whether a block's namespace is one no plugin of the site registers. */
export const isUnregisteredBlock = (model: WpModel, name: string | null): boolean =>
  name !== null && unregisteredBlockNamespaces(model).has(name.split("/", 1)[0]!);

/** The namespaces of the blocks the posts, templates and parts hold, `core` excepted. */
export function usedBlockNamespaces(model: WpModel): Set<string> {
  const found = new Set<string>();
  for (const post of model.posts.values()) {
    for (const m of post.content.matchAll(/<!--\s+wp:([a-z0-9][a-z0-9-]*)\//g)) {
      if (m[1] !== "core") found.add(m[1]!);
    }
  }
  return found;
}

const MAX_BYTES = 3_000_000;

/**
 * The namespaces among `namespaces` that no file of the plugins, the must-use plugins and the themes
 * under `root` (a WordPress checkout, `wp-content` inside) names as a quoted `namespace/…`. Nothing is
 * claimed when the checkout has no plugins folder: an empty set.
 */
export async function findUnregisteredNamespaces(
  root: string,
  namespaces: ReadonlySet<string>,
): Promise<Set<string>> {
  const content = join(root, "wp-content");
  if (namespaces.size === 0 || !existsSync(join(content, "plugins"))) return new Set();
  const pending = new Map(
    [...namespaces].map((ns) => [ns, new RegExp(`['"\`]${ns}(?:\\\\)?/[a-z0-9]`)] as const),
  );
  const files: string[] = [];
  const glob = new Glob("{plugins,mu-plugins,themes}/**/*.{php,json,js,mjs}");
  for await (const file of glob.scan({ cwd: content, onlyFiles: true })) {
    if (!file.includes("/node_modules/")) files.push(join(content, file));
  }
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length && pending.size > 0) {
      const file = Bun.file(files[next++]!);
      if (file.size > MAX_BYTES) continue;
      const text = await file.text();
      for (const [ns, pattern] of pending) {
        if (text.includes(ns) && pattern.test(text)) pending.delete(ns);
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, worker));
  return new Set(pending.keys());
}
