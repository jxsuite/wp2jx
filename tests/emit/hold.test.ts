/**
 * The entries a build holds back (a content type's `hold`, jxsuite/jx#548): the drafts, the posts
 * pending review, the scheduled, private and password-protected posts of anabaptistperspectives'
 * essays, written as entries with what holds them, the collection's rules, and a real `jx build` that
 * leaves them out (and `--include-held`, which keeps them for a preview).
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import {
  HOLD_RULES,
  buildCollections,
  type CollectionsOutput,
} from "../../src/emit/collections.ts";
import { readFileSync } from "node:fs";
import { JX_HOLD_MINIMUM, jxHolds, projectPackageJson } from "../../src/emit/project.ts";
import { HELD_STATUSES, buildRoutes, createUrlTools } from "../../src/routes.ts";
import type { SiteContext } from "../../src/site.ts";
import type { WpPost } from "../../src/types.ts";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "../helpers/jx-build.ts";
import { loadSite } from "../helpers/ctx.ts";

setDefaultTimeout(300_000);
afterAll(cleanupJxProjects);

const NOW = new Date("2026-01-01T00:00:00Z");

/** The essays site with three of its posts made a draft (with no slug yet), a scheduled post and a password-protected one. */
async function heldSite(): Promise<{
  site: SiteContext;
  ids: Record<string, number>;
  picked: Set<number>;
}> {
  const base = await loadSite("ap");
  const essays = [...base.model.posts.values()]
    .filter((p) => p.type === "post" && p.status === "publish")
    .sort((a, b) => a.id - b.id);
  const [published, draft, scheduled, gated] = essays as [WpPost, WpPost, WpPost, WpPost];
  const posts = new Map(base.model.posts);
  posts.set(draft.id, { ...draft, status: "draft", slug: "" });
  posts.set(scheduled.id, { ...scheduled, status: "future", date: "2099-05-01T09:00:00.000Z" });
  posts.set(gated.id, { ...gated, passwordProtected: true });
  const model = { ...base.model, posts };
  const routes = buildRoutes(model, base.acf, { media: base.media, held: HELD_STATUSES });
  const site: SiteContext = {
    ...base,
    model,
    routes,
    urls: createUrlTools(model, routes, base.media),
  };
  const ids = {
    published: published.id,
    draft: draft.id,
    scheduled: scheduled.id,
    gated: gated.id,
  };
  return { site, ids, picked: new Set(Object.values(ids)) };
}

const frontmatterOf = (out: CollectionsOutput, postId: number): Record<string, unknown> => {
  const entry = out.entries.find((e) => e.postId === postId)!;
  const text = out.files.find((f) => f.path === entry.file)!.content;
  return parseYaml(/^---\n([\s\S]*?)\n---/.exec(text)![1]!) as Record<string, unknown>;
};

describe("the entries a build holds back", () => {
  let out: CollectionsOutput;
  let ids: Record<string, number>;
  let site: SiteContext;
  test("setup", async () => {
    const held = await heldSite();
    ({ site, ids } = held);
    out = await buildCollections(site, {
      now: NOW,
      include: (p) => held.picked.has(p.id),
      hold: true,
    });
  });

  test("are written with WordPress's status and the password that gates one; the public ones say they are published", () => {
    expect(out.entries.map((e) => e.postId).sort()).toEqual(Object.values(ids).sort());
    expect(frontmatterOf(out, ids.published!)).toMatchObject({ postStatus: "publish" });
    expect(frontmatterOf(out, ids.published!)).not.toHaveProperty("passwordProtected");
    expect(frontmatterOf(out, ids.draft!)).toMatchObject({ postStatus: "draft" });
    expect(frontmatterOf(out, ids.scheduled!)).toMatchObject({
      postStatus: "future",
      date: "2099-05-01T09:00:00Z",
    });
    expect(frontmatterOf(out, ids.gated!)).toMatchObject({
      postStatus: "publish",
      passwordProtected: true,
    });
    // the draft's file is where WordPress will put it once published: the slug of its title
    const draft = out.entries.find((e) => e.postId === ids.draft)!;
    expect(draft.file).toBe(site.routes.held().find((r) => r.id === ids.draft)!.file);
    expect(site.routes.forPost(ids.draft!)).toBeUndefined();
  });

  test("the collection says what holds an entry back, and its schema offers the statuses and the switch", () => {
    const def = out.collections.post!;
    expect(def.hold).toEqual([...HOLD_RULES]);
    expect(def.hold!.map((r) => r.label)).toEqual([
      "Draft",
      "Pending review",
      "Private",
      "Scheduled",
      "Password protected",
    ]);
    expect(def.schema.properties).toMatchObject({
      postStatus: { type: "string", enum: ["publish", ...HELD_STATUSES] },
      passwordProtected: { type: "boolean" },
    });
    expect(out.report.entries().filter((e) => e.code === "collection.held")).toHaveLength(2);
    expect(out.report.entries().filter((e) => e.code === "entry.schema-invalid")).toEqual([]);
  });

  test("without hold they are left out, as before, and the collection has no rules", async () => {
    const held = await heldSite();
    const plain = await buildCollections(held.site, {
      now: NOW,
      include: (p) => held.picked.has(p.id),
    });
    // the scheduled post is not published yet, the draft has no address, the gated one shows a form
    expect(plain.entries.map((e) => e.postId)).toEqual([held.ids.published!]);
    expect(plain.collections.post!.hold).toBeUndefined();
    expect(frontmatterOf(plain, held.ids.published!)).not.toHaveProperty("postStatus");
    expect(plain.report.entries().map((e) => e.code)).toContain("collection.protected");
  });

  test("built by Jx: a build leaves them out of every page and the sitemap; --include-held keeps them for a preview", async () => {
    const def = out.collections.post!;
    const files: Record<string, string | object> = {
      "project.json": {
        name: "hold",
        url: "https://x.org",
        extensions: ["@jxsuite/parser"],
        content: { post: { ...def, $elements: [] } },
      },
      "pages/index.json": {
        title: "t",
        state: {
          all: {
            $prototype: "ContentCollection",
            $src: "@jxsuite/parser/ContentCollection.class.json",
            contentType: "post",
            timing: "compiler",
          },
        },
        children: [
          {
            tagName: "ul",
            children: [
              "${(state.all).map(($i0) => ({ tagName: 'li', textContent: $i0.data.url }))}",
            ],
          },
        ],
      },
    };
    for (const f of out.files) files[f.path] = f.content;
    const urlOf = (id: number): string => String(frontmatterOf(out, id).url);
    const listed = (html: string): string[] =>
      [...html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]!);

    const built = await buildJxProject(files, { name: "hold" });
    expect(listed(built.html("/"))).toEqual([urlOf(ids.published!)]);
    expect(built.stdout).toMatch(/holding 3 from this build/);
    const sitemap = built.read("sitemap.xml");
    for (const id of [ids.draft!, ids.scheduled!, ids.gated!]) {
      expect(sitemap).not.toContain(urlOf(id));
      expect(built.exists(`${urlOf(id).replace(/^\/|\/$/g, "")}/index.html`)).toBe(false);
    }
    expect((await validateJxProject(built.dir)).problems).toEqual([]);

    const preview = await buildJxProject(files, { name: "hold-preview", args: ["--include-held"] });
    expect(listed(preview.html("/")).sort()).toEqual(Object.values(ids).map(urlOf).sort());
  });
});

describe("the Jx a project with held entries asks for", () => {
  test("the installed Jx is one that holds (its parser's schema has `hold`)", () => {
    expect(jxHolds()).toBe(true);
  });

  test("a project that holds entries back asks for the first releases with `hold` at least", () => {
    const pkg = JSON.parse(projectPackageJson("x", true, true));
    // the higher of the release installed here and the first release with hold
    const atLeast = (name: keyof typeof JX_HOLD_MINIMUM): string => {
      const version = JSON.parse(
        readFileSync(`${import.meta.dir}/../../node_modules/${name}/package.json`, "utf8"),
      ).version as string;
      const minimum = JX_HOLD_MINIMUM[name];
      return `^${Bun.semver.order(version, minimum) < 0 ? minimum : version}`;
    };
    expect(pkg.dependencies["@jxsuite/parser"]).toBe(atLeast("@jxsuite/parser"));
    expect(pkg.devDependencies["@jxsuite/compiler"]).toBe(atLeast("@jxsuite/compiler"));
    expect(pkg.devDependencies["@jxsuite/runtime"]).toBe(atLeast("@jxsuite/runtime"));
    // one that holds nothing asks for the release installed here
    const plain = JSON.parse(projectPackageJson("x", true));
    const installed = JSON.parse(
      readFileSync(`${import.meta.dir}/../../node_modules/@jxsuite/parser/package.json`, "utf8"),
    ).version;
    expect(plain.dependencies["@jxsuite/parser"]).toBe(`^${installed}`);
  });
});
