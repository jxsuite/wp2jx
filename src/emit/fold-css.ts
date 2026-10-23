/**
 * No stylesheet files: every sheet the project would ship becomes style rules, and the classes those
 * rules name are written into the elements that carry them (`emit/inline-classes.ts`).
 *
 * The emitters still produce their sheets (the plugin's base CSS, the global faces, the owner's CSS,
 * the core block rules a style object could not carry, the forms', the image compare's and the maps'
 * plugin CSS, WordPress's Additional CSS) and the `$head` entries that link them, and the design
 * system the project `style`. {@link foldStylesheets} takes them all out of the files and the head,
 * reads each sheet into rules, and puts the rules in the order the live site printed them:
 *
 *   1. the plugin's base CSS and the theme's style.css      (`compat`)
 *   2. the forms', image compare's and maps' plugin CSS      (linked right after it)
 *   3. the global faces and other at-rules                   (`global`)
 *   4. the site owner's CSS                                  (`custom`: between the global CSS and the classes)
 *   5. inline `<style>` of the head (custom code)
 *   6. the project style: global CSS, global classes, core blocks, what the pages hoisted
 *   7. the core rules the project style could not carry
 *   8. WordPress Additional CSS                              (`additional`: printed last of all)
 *   9. `<style>` elements of the pages' and components' markup (an author's HTML block), which the
 *      page prints in its body; the elements go
 *
 * (The project style's own order is kept: it is read the way the site builder emits it.) The class
 * rules then move into the elements, and what is left is written back into one `project.json` style
 * object by `OrderedStyle`, which keeps each declaration where it wins.
 *
 * What a style object cannot hold is said and left out, never shipped as a file:
 *
 * - `@font-face`: `project.json` cannot hold several (the array form fails `jx validate` and the site
 *   style builder drops it, Jx 5), an element's style can. The faces go on the root of the base layout,
 *   which every page has; a site with no base layout gets them on the root of every page and layout.
 * - `@import`: a link in `$head` (the font imports), as before.
 * - statement at-rules and the ones Jx has no key for (`@page`, `@font-feature-values`, `@layer a, b;`):
 *   dropped and reported (`css.statement-dropped`).
 *
 * Report codes: `css.folded`, `css.classes-inlined`, `css.font-faces`, `css.statement-dropped`,
 * `css.relative-url`.
 */
import type { JxHeadEntry } from "@jxsuite/schema/types";
import { cssRules, parseCwiclyCss, type PaletteColour } from "../cwicly/css.ts";
import type { Breakpoint, JxStyle, Report } from "../types.ts";
import { collectFontImports, escapeStyleTemplates } from "./design-system.ts";
import { inlineClasses, type ProjectRule } from "./inline-classes.ts";
import {
  flattenProjectStyle,
  isBlock,
  isUnscopedAtRule,
  OrderedStyle,
  type FlatRule,
} from "./style-order.ts";

type Rec = Record<string, unknown>;

/** A stylesheet the emitters wrote, or the project style itself, in cascade order. */
export type FoldSource =
  | { kind: "file"; path: string; label: string }
  | { kind: "head-styles" }
  | { kind: "project-style" };

export interface FoldInput {
  files: Map<string, string | Uint8Array>;
  head: JxHeadEntry[];
  /** The composed project style. */
  style: JxStyle;
  /** The sheets in the order the live site printed them; files not present are skipped. */
  order: readonly FoldSource[];
  breakpoints: readonly Breakpoint[];
  media: Readonly<Record<string, string>>;
  palette?: readonly PaletteColour[] | undefined;
  /** The base layout's file (`layouts/base.json`), which takes the `@font-face` rules. */
  baseLayout?: string | undefined;
  /** Classes a third-party script looks for. */
  protect?: Iterable<string>;
  report: Report;
  /** How a JSON document is written (the project's `jsonText`). */
  serialize: (value: unknown) => string;
}

const text = (content: string | Uint8Array): string =>
  typeof content === "string" ? content : new TextDecoder().decode(content);

const hrefOf = (path: string): string => `/${path.replace(/^public\//, "")}`;

/** Fold the stylesheets into the project style and the elements: see the module comment. Returns the new style. */
export function foldStylesheets(input: FoldInput): JxStyle {
  const { files, head, report } = input;
  const rules: ProjectRule[] = [];
  const extras: [string, unknown][] = [];
  const faces: JxStyle[] = [];
  const folded: string[] = [];
  let rank = 0;
  const push = (rule: FlatRule): void => {
    rules.push({ ...rule, rank: (rank += 1) });
  };

  const readSheet = (css: string, where: string): void => {
    const index = parseCwiclyCss(css, input.breakpoints, { file: where, palette: input.palette });
    for (const part of cssRules(index)) {
      push({
        selector: part.selector,
        context: [...part.context],
        // `${` would be evaluated as a Jx template wherever the value lands: the dollar as a CSS escape.
        declarations: part.declarations.map(([k, v]) => [k, v.replaceAll("${", "\\24 {")]),
      });
    }
    for (const entry of collectFontImports([index], { report, where: `file:${where}` })) {
      const href = entry.attributes?.href;
      if (!head.some((e) => e.tagName === "link" && e.attributes?.href === href)) head.push(entry);
    }
    for (const { key, style } of index.atRules) {
      if (/^@import\b/i.test(key)) continue;
      if (/^@font-face\b/i.test(key)) faces.push(style);
      else if (isUnscopedAtRule(key)) extras.push([key, style]);
      else {
        report.add({
          severity: "warn",
          code: "css.statement-dropped",
          message: `${key} in ${where} has no place in a Jx style object, so it was left out.`,
          where: `file:${where}`,
          data: { rule: key },
        });
      }
    }
    const lost = index.artifacts.filter((a) => a.code === "css.unclassified").map((a) => a.detail);
    if (lost.length > 0) {
      report.add({
        severity: "warn",
        code: "css.statement-dropped",
        message: `${lost.length} rule${lost.length === 1 ? "" : "s"} or at-rule${lost.length === 1 ? "" : "s"} of ${where} have no Jx style spelling and were left out: ${lost.slice(0, 8).join("; ")}${lost.length > 8 ? "; …" : ""}`,
        where: `file:${where}`,
        data: { lost: lost.slice(0, 50) },
      });
    }
    if (/url\(\s*['"]?(?!data:|https?:|\/|#)/i.test(css)) {
      report.add({
        severity: "warn",
        code: "css.relative-url",
        message: `${where} has a relative url(), which now resolves against each page instead of the stylesheet's folder.`,
        where: `file:${where}`,
      });
    }
  };

  const dropLink = (path: string): void => {
    const href = hrefOf(path);
    for (let at = head.length - 1; at >= 0; at--) {
      const entry = head[at]!;
      if (entry.tagName === "link" && entry.attributes?.href === href) head.splice(at, 1);
    }
  };

  const seen = new Set<string>(
    input.order.flatMap((source) => (source.kind === "file" ? [source.path] : [])),
  );
  for (const source of input.order) {
    if (source.kind === "file") {
      const content = files.get(source.path);
      if (content === undefined) continue;
      readSheet(text(content), source.label);
      files.delete(source.path);
      dropLink(source.path);
      folded.push(source.label);
    } else if (source.kind === "head-styles") {
      for (let at = 0; at < head.length; at++) {
        const entry = head[at]!;
        const local =
          entry.tagName === "link" &&
          entry.attributes?.rel === "stylesheet" &&
          typeof entry.attributes.href === "string" &&
          entry.attributes.href.startsWith("/");
        if (entry.tagName === "style" && typeof entry.textContent === "string") {
          readSheet(entry.textContent, "head <style>");
          head.splice(at--, 1);
          folded.push("head <style>");
        } else if (local) {
          const path = `public${entry.attributes!.href as string}`;
          const content = files.get(path);
          if (content === undefined || seen.has(path)) continue;
          readSheet(text(content), path);
          files.delete(path);
          head.splice(at--, 1);
          folded.push(path);
        }
      }
    } else {
      const flat = flattenProjectStyle(input.style);
      for (const rule of flat.rules) push(rule);
      extras.push(...flat.extras);
    }
  }

  // ── The documents ───────────────────────────────────────────────────────────────────────────────
  const documents: { path: string; doc: unknown }[] = [];
  const markdown: string[] = [];
  const scripts: string[] = [];
  for (const [path, content] of files) {
    if (path === "project.json") continue;
    if (path.endsWith(".json") && /^(?:pages|layouts|components|content)\//.test(path)) {
      try {
        documents.push({ path, doc: JSON.parse(text(content)) });
      } catch {
        // Not JSON a person could have meant: nothing to rewrite.
      }
    } else if (path.endsWith(".md")) markdown.push(text(content));
    else if (/\.m?js$/.test(path)) scripts.push(text(content));
  }
  for (const entry of head) {
    if (entry.tagName === "script" && typeof entry.textContent === "string")
      scripts.push(entry.textContent);
  }
  // A `<style>` element in a page's or component's markup (an author's HTML block) is a stylesheet too,
  // printed in the body, after everything the head holds: its rules come last, and the element goes.
  const bodySheets = new Set<string>();
  for (const { path, doc } of documents) {
    const take = (node: unknown): void => {
      if (!isBlock(node) || !Array.isArray(node.children)) return;
      node.children = node.children.filter((child: unknown) => {
        if (!isBlock(child)) return true;
        const css =
          child.tagName === "style"
            ? (child.innerHTML ?? child.textContent)
            : child.tagName === "link" &&
                isBlock(child.attributes) &&
                child.attributes.rel === "stylesheet" &&
                typeof child.attributes.href === "string" &&
                files.has(`public${child.attributes.href}`)
              ? text(files.get(`public${child.attributes.href}`)!)
              : undefined;
        if (typeof css !== "string" || css.includes("${")) {
          take(child);
          return true;
        }
        readSheet(css, `${path} <${child.tagName as string}>`);
        bodySheets.add(path);
        return false;
      });
    };
    take(doc);
  }
  for (const path of bodySheets) folded.push(`the <style> of ${path}`);
  const inlined = inlineClasses({
    rules,
    documents,
    markdown,
    scripts,
    protect: input.protect ?? [],
    media: input.media,
  });

  // ── The faces ───────────────────────────────────────────────────────────────────────────────────
  if (faces.length > 0) {
    const targets =
      input.baseLayout !== undefined && documents.some((d) => d.path === input.baseLayout)
        ? documents.filter((d) => d.path === input.baseLayout)
        : documents.filter((d) => /^(?:pages|layouts)\//.test(d.path));
    for (const target of targets) {
      if (!isBlock(target.doc)) continue;
      const style = (isBlock(target.doc.style) ? target.doc.style : {}) as Rec;
      const before = style["@font-face"];
      const list = Array.isArray(before) ? before : isBlock(before) ? [before] : [];
      style["@font-face"] = [...list, ...faces];
      target.doc.style = style;
      inlined.changed.add(target.path);
    }
    report.add({
      severity: "info",
      code: "css.font-faces",
      message: `${faces.length} @font-face rule${faces.length === 1 ? "" : "s"} went on the root of ${targets.length === 1 ? targets[0]!.path : `${targets.length} pages and layouts`}: project.json's style cannot hold several.`,
      where: "project.json",
      data: { faces: faces.length, targets: targets.map((t) => t.path) },
    });
  }
  for (const { path, doc } of documents) {
    if (inlined.changed.has(path) || bodySheets.has(path)) files.set(path, input.serialize(doc));
  }

  // ── What stays in the project ──────────────────────────────────────────────────────────────────
  const built = new OrderedStyle("project", input.media);
  for (const rule of inlined.rules) {
    rule.declarations.forEach(([property, value], i) =>
      built.place(rule.selector, rule.context, { property, value, rank: rule.rank * 10_000 + i }),
    );
  }
  const seenExtra = new Map<string, unknown>();
  for (const [key, value] of extras) seenExtra.set(key, value);
  built.extras.push(...seenExtra);
  const style = built.toStyle();
  escapeStyleTemplates(style);

  report.add({
    severity: "info",
    code: "css.folded",
    message: `No stylesheet file is shipped: ${folded.length === 0 ? "the project style" : folded.join(", ")} became style rules (${inlined.rules.length} rules stay in project.json's style${built.aliased > 0 ? `, ${built.aliased} declarations in an alias block to keep their order` : ""}).`,
    where: "project.json",
    data: { sheets: folded, rules: inlined.rules.length, aliased: built.aliased },
  });
  const s = inlined.stats;
  report.add({
    severity: "info",
    code: "css.classes-inlined",
    message: `${s.rulesMoved} class rules were written into the ${s.elements} elements that carry them, ${s.rulesDead} rules for classes nothing carries were dropped, and ${s.classesRemoved} class names were taken off elements (${s.classesGone} classes are gone from the site; ${s.aliased} declarations went into an alias block to keep the cascade).`,
    where: "project.json",
    data: { ...s },
  });
  return style;
}
