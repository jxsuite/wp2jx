/**
 * `lazyblock/<slug>` blocks whose template is a recipe: the markup the template echoes, with the entry's
 * own data in its holes. The context is anabaptistperspectives' single-episode template; the block
 * definitions are written out (see `tests/wp/lazyblocks.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { lazyBlock } from "../../../src/cwicly/blocks/lazyblocks.ts";
import { convertBlocks } from "../../../src/convert.ts";
import type { ConvertCtx, JxElement, WpBlock, WpModel, WpPost } from "../../../src/types.ts";
import { loadSite, makeCtx } from "../../helpers/ctx.ts";
import { postData } from "../../../src/cwicly/tokens.ts";
import { AUDIO_PHP, DASHBOARD_PHP, VIDEO_PHP } from "../../wp/lazyblocks.test.ts";

const post = (id: number, over: Partial<WpPost> = {}): WpPost =>
  ({ id, type: "post", status: "publish", title: `Post ${id}`, ...over }) as WpPost;

function modelWith(
  base: WpModel,
  defs: [number, string, string][],
  extraMeta: Record<number, Record<string, unknown[]>> = {},
  posts: WpPost[] = [],
): WpModel {
  const lazy = defs.map(([id]) => post(id, { type: "lazyblocks" }));
  const meta = new Map(base.postMeta);
  for (const [id, slug, code] of defs)
    meta.set(id, { lazyblocks_slug: [slug], lazyblocks_code_frontend_html: [code] });
  for (const [id, m] of Object.entries(extraMeta)) meta.set(Number(id), m);
  return {
    ...base,
    posts: new Map([...base.posts, ...[...lazy, ...posts].map((p) => [p.id, p] as const)]),
    postMeta: meta,
  } as WpModel;
}

const block = (name: string): WpBlock => ({
  name,
  attrs: {},
  innerBlocks: [],
  innerHTML: "",
  innerContent: [],
});

const DEFS: [number, string, string][] = [
  [90001, "episode-audio-embed", AUDIO_PHP],
  [90002, "no-slug", VIDEO_PHP],
  [90003, "donor-dashboard-here", DASHBOARD_PHP],
];

async function entryCtx(): Promise<ConvertCtx> {
  const ctx = await makeCtx(
    "ap",
    { kind: "template", slug: "single-episode" },
    { mode: "entry", entryExpr: "state.entry", entryType: "episode" },
  );
  return { ...ctx, model: modelWith(ctx.model, DEFS) };
}

/** The value a binding (`${…}`) has for the entry data `data`. */
function bound(value: unknown, data: Record<string, unknown>): unknown {
  const m = /^\$\{([\s\S]*)\}$/.exec(String(value));
  if (m === null) return value;
  return new Function("state", `return (${m[1]});`)({ entry: { data } });
}

const el = (n: unknown): JxElement => n as JxElement;

describe("an entry template", () => {
  test("the audio block is the plugin's wrapper, the echoed iframe and link, bound to the entry's captivate data", async () => {
    const ctx = await entryCtx();
    const [wrapper] = convertBlocks([block("lazyblock/episode-audio-embed")], ctx).map(el);
    expect(wrapper!.className).toBe(
      "lazyblock-episode-audio-embed wp-block-lazyblock-episode-audio-embed",
    );
    const [frame, link] = (wrapper!.children as JxElement[]).map(el);
    expect(frame!.tagName).toBe("iframe");
    expect(frame!.attributes).toMatchObject({
      frameborder: "no",
      scrolling: "no",
      seamless: "",
      style:
        "width: 100%; height: auto; aspect-ratio: 2 / 1; display: flex; align-items: flex-end;",
    });
    expect(link!.tagName).toBe("a");
    expect(link!.textContent).toBe("Download Audio");
    expect(link!.attributes).toMatchObject({
      target: "_blank",
      rel: "noopener noreferrer",
      download: "",
    });

    const data = {
      captivate: { episodeId: "6eea7228", downloadUrl: "https://pod.test/a.mp3?download=1" },
    };
    expect(bound(frame!.attributes!.src, data)).toBe(
      "https://player.captivate.fm/episode/6eea7228",
    );
    expect(bound(link!.attributes!.href, data)).toBe("https://pod.test/a.mp3?download=1");
    expect(bound(frame!.attributes!.hidden, data)).toBe(false);
    expect(bound(link!.attributes!.hidden, data)).toBe(false);
    // An entry with no episode: no address at all (a hidden iframe still loads its src), and both hidden.
    for (const nothing of [{}, { captivate: {} }]) {
      expect(bound(frame!.attributes!.src, nothing)).toBe(false);
      expect(bound(link!.attributes!.href, nothing)).toBe(false);
      expect(bound(frame!.attributes!.hidden, nothing)).toBe(true);
    }
    expect(frame!.style).toMatchObject({ "&[hidden]": { display: "none !important" } });
    expect(
      ctx.report
        .entries()
        .filter((e) => e.code === "lazyblock.recipe")
        .map((e) => e.severity),
    ).toEqual(["info"]);
  });

  test("the video block embeds the entry's YouTube address, and a gated entry has none", async () => {
    const ctx = await entryCtx();
    const [wrapper] = convertBlocks([block("lazyblock/no-slug")], ctx).map(el);
    const [frame] = (wrapper!.children as JxElement[]).map(el);
    const embed = (id: string) =>
      `//www.youtube-nocookie.com/embed/${id}?rel=0&modestbranding=1&hd=1&showinfo=0&controls=1&iv_load_policy=3&wmode=transparent&autohide=1&autoplay=0`;
    const watch = { youtube: "https://www.youtube.com/watch?v=922QNv2JBFo" };
    expect(bound(frame!.attributes!.src, watch)).toBe(embed("922QNv2JBFo"));
    expect(bound(frame!.attributes!.hidden, watch)).toBe(false);
    expect(bound(frame!.attributes!.src, { youtube: "https://youtu.be/abc_DEF-123" })).toBe(
      embed("abc_DEF-123"),
    );
    for (const none of [{}, { youtube: "" }, { youtube: "https://vimeo.com/1" }]) {
      expect(bound(frame!.attributes!.src, none)).toBe(false);
      expect(bound(frame!.attributes!.hidden, none)).toBe(true);
    }
    // The gate: the address is in the entry and the page must not carry it.
    for (const premium of [true, "1"]) {
      expect(bound(frame!.attributes!.src, { ...watch, premium })).toBe(false);
      expect(bound(frame!.attributes!.hidden, { ...watch, premium })).toBe(true);
    }
    expect(bound(frame!.attributes!.src, { ...watch, premium: "0" })).toBe(embed("922QNv2JBFo"));
    // The site's field is a link: `{title, url, target}`, as an entry holds it (real data of an episode).
    const link = {
      youtube: { title: "", url: "https://www.youtube.com/watch?v=922QNv2JBFo", target: "" },
    };
    expect(bound(frame!.attributes!.src, link)).toBe(embed("922QNv2JBFo"));
    expect(bound(frame!.attributes!.hidden, link)).toBe(false);
    expect(bound(frame!.attributes!.src, { youtube: { title: "", url: "", target: "" } })).toBe(
      false,
    );
    const real = (await loadSite("ap")).model;
    const episode = [...real.posts.values()].find(
      (p) => p.type === "episode" && postData(ctx, p).youtube !== undefined,
    )!;
    const data = postData(ctx, episode);
    expect(typeof (data.youtube as { url?: string }).url).toBe("string");
    expect(String(bound(frame!.attributes!.src, data))).toMatch(
      /^\/\/www\.youtube-nocookie\.com\/embed\/[\w-]{6,}\?rel=0/,
    );
  });

  test("a template that is not a recipe, a block no one defines and a Markdown entry stay with the generic path", async () => {
    const ctx = await entryCtx();
    expect(lazyBlock(block("lazyblock/donor-dashboard-here"), ctx)).toBeUndefined();
    expect(lazyBlock(block("lazyblock/nothing-defined"), ctx)).toBeUndefined();
    expect(lazyBlock(block("core/paragraph"), ctx)).toBeUndefined();
    expect(
      lazyBlock(block("lazyblock/episode-audio-embed"), { ...ctx, target: "markdown" }),
    ).toBeUndefined();
    // through the driver they are the placeholder and a warning, as before
    const out = convertBlocks([block("lazyblock/donor-dashboard-here")], ctx).map(el);
    expect(out[0]!.tagName).toBe("wp2jx-block");
    expect(ctx.report.entries().map((e) => e.code)).toContain("block.unsupported");
    // a template that prints a variable the recipe does not know is not filled in with a guess
    const odd = modelWith(ctx.model, [
      [90009, "odd", AUDIO_PHP.replace("{$cfm_download_url}", "{$surprise}")],
    ]);
    expect(lazyBlock(block("lazyblock/odd"), { ...ctx, model: odd })).toBeUndefined();
    // and with no entry to read there is nothing to bind to
    expect(
      lazyBlock(block("lazyblock/episode-audio-embed"), { ...ctx, mode: "component" }),
    ).toBeUndefined();
  });
});

describe("a static page", () => {
  test("the player is written with the values of the page's own post, and nothing for a gated post", async () => {
    const base = await entryCtx();
    // A page (a Markdown entry cannot hold the player).
    const episode = post(50, { type: "page" });
    const model = modelWith(
      base.model,
      DEFS,
      {
        50: {
          captivate_episode: ["51"],
          youtube: [{ title: "", url: "https://youtu.be/922QNv2JBFo", target: "" }],
          premium: ["0"],
        },
        51: { cfm_episode_id: ["6eea7228"], cfm_episode_media_url: ["https://pod.test/a.mp3"] },
        52: {
          captivate_episode: ["51"],
          youtube: ["https://youtu.be/922QNv2JBFo"],
          premium: ["1"],
        },
      },
      [episode, post(51, { type: "captivate_podcast" }), post(52, { type: "page" })],
    );
    const at = (id: number): ConvertCtx => ({
      ...base,
      mode: "static",
      model,
      subject: {
        kind: "post",
        id: String(id),
        post: model.posts.get(id)!,
      } as ConvertCtx["subject"],
    });
    const audio = el(convertBlocks([block("lazyblock/episode-audio-embed")], at(50))[0]);
    const [frame, link] = (audio.children as JxElement[]).map(el);
    expect(frame!.attributes!.src).toBe("https://player.captivate.fm/episode/6eea7228");
    expect(link!.attributes!.href).toBe("https://pod.test/a.mp3?download=1");
    expect(frame!.attributes!.hidden).toBeUndefined();
    const video = el(convertBlocks([block("lazyblock/no-slug")], at(50))[0]);
    expect(el((video.children as JxElement[])[0]).attributes!.src).toContain(
      "/embed/922QNv2JBFo?rel=0",
    );
    const gated = el(convertBlocks([block("lazyblock/no-slug")], at(52))[0]);
    expect(gated.className).toBe("lazyblock-no-slug wp-block-lazyblock-no-slug");
    expect(gated.children).toBeUndefined();
    expect(
      JSON.stringify(convertBlocks([block("lazyblock/episode-audio-embed")], at(52))),
    ).not.toContain("captivate.fm/episode/6eea");
  });
});
