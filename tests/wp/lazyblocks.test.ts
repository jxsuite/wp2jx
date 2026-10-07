/**
 * Lazy Blocks templates and their recipes. The two PHP templates are anabaptistperspectives' own, as
 * stored in the `lazyblocks_code_frontend_html` meta of its blocks "Episode Video Embed" and "Episode
 * Audio Embed" (the committed fixture rows keep no `lazyblocks` posts, so the code is written out here).
 */
import { describe, expect, test } from "bun:test";
import type { WpModel, WpPost } from "../../src/types.ts";
import {
  addressOf,
  gatedPost,
  lazyBlockDefs,
  recipeData,
  recipeFor,
  recipeOf,
  youtubeId,
} from "../../src/wp/lazyblocks.ts";

export const VIDEO_PHP = `<?php
$post_id = get_the_ID();
$is_premium = get_field('premium', $post_id);
$can_access = true;
if ($is_premium) {
  $can_access = current_user_can( 'read_premium_content' );
}
if ($can_access) {
  $youtube_link = get_field('youtube', $post_id);
  if ($youtube_link) {
    preg_match("/^(?:http(?:s)?:\\/\\/)?(?:www\\.)?(?:m\\.)?(?:youtu\\.be\\/|youtube\\.com\\/(?:(?:watch)?\\?(?:.*&)?v(?:i)?=|(?:embed|v|vi|user|shorts)\\/))([^\\?&\\"'>]+)/", $youtube_link, $matches);
    $youtube_id = $matches[1];
  } elseif (is_admin()) {
    $youtube_id = 'DcnIA_NDafY';
  }
  if ($youtube_id) {
    echo "<iframe style=\\"width: 100%; height: auto; aspect-ratio: 16 / 9; display: flex; align-items: flex-end;\\" src=\\"//www.youtube-nocookie.com/embed/{$youtube_id}?rel=0&modestbranding=1&hd=1&showinfo=0&controls=1&iv_load_policy=3&wmode=transparent&autohide=1&autoplay=0\\" frameborder=\\"0\\" allowfullscreen></iframe>";
  }
}
`;

export const AUDIO_PHP = `<?php
$post_id = get_the_ID();
$is_premium = get_field('premium', $post_id);
$can_access = true;
if ($is_premium) {
  $can_access = current_user_can( 'read_premium_content' );
}
if ($can_access) {
  $captivate_episode_id = get_field('captivate_episode', $post_id);
  if ($captivate_episode_id) {
    $cfm_episode = get_post_meta($captivate_episode_id, 'cfm_episode_id');
    $cfm_episode_id = $cfm_episode[0];
    $cfm_download_url = get_post_meta($captivate_episode_id, 'cfm_episode_media_url')[0].'?download=1';
    echo "<iframe style=\\"width: 100%; height: auto; aspect-ratio: 2 / 1; display: flex; align-items: flex-end;\\" frameborder=\\"no\\" scrolling=\\"no\\" seamless src=\\"https://player.captivate.fm/episode/{$cfm_episode_id}\\"></iframe>";
    echo "<a href=\\"{$cfm_download_url}\\" target=\\"_blank\\" rel=\\"noopener noreferrer\\" download>Download Audio</a>";
  }
}`;

export const DASHBOARD_PHP = `<?php
namespace Give\\DonorDashboards;
use Give\\Helpers\\EnqueueScript;
EnqueueScript::make('give-donor-dashboards-app', 'build/assets/dist/js/donor-dashboards-app.js')->loadInFooter()->enqueue();
echo '<div id="give-donor-dashboard"></div>';`;

const post = (id: number, over: Partial<WpPost> = {}): WpPost =>
  ({ id, type: "post", status: "publish", title: `Post ${id}`, ...over }) as WpPost;

/** A model of just the parts the recipes read. */
function modelOf(posts: WpPost[], meta: Record<number, Record<string, unknown[]>> = {}): WpModel {
  return {
    posts: new Map(posts.map((p) => [p.id, p])),
    postMeta: new Map(Object.entries(meta).map(([k, v]) => [Number(k), v])),
  } as unknown as WpModel;
}

const block = (id: number, slug: string, code: string, over: Partial<WpPost> = {}) => ({
  post: post(id, { type: "lazyblocks", ...over }),
  meta: { lazyblocks_slug: [slug], lazyblocks_code_frontend_html: [code] },
});

function siteWith(extra: Record<number, Record<string, unknown[]>> = {}, posts: WpPost[] = []) {
  const audio = block(665, "episode-audio-embed", AUDIO_PHP);
  const video = block(664, "no-slug", VIDEO_PHP);
  const dashboard = block(2095, "donor-dashboard-here", DASHBOARD_PHP);
  const draft = block(9, "draft-one", AUDIO_PHP, { status: "draft" });
  return modelOf([audio.post, video.post, dashboard.post, draft.post, ...posts], {
    665: audio.meta,
    664: video.meta,
    2095: dashboard.meta,
    9: draft.meta,
    ...extra,
  });
}

describe("lazyBlockDefs", () => {
  test("the published blocks of the site by slug; a block with no slug is `no-slug`, a draft is not a block", () => {
    const defs = lazyBlockDefs(siteWith());
    expect([...defs.keys()].sort()).toEqual([
      "donor-dashboard-here",
      "episode-audio-embed",
      "no-slug",
    ]);
    expect(defs.get("no-slug")).toMatchObject({ postId: 664, title: "Post 664" });
    const bare = modelOf([post(1, { type: "lazyblocks" })], {
      1: { lazyblocks_code_frontend_html: ["<?php"] },
    });
    expect([...lazyBlockDefs(bare).keys()]).toEqual(["no-slug"]);
    expect(lazyBlockDefs(modelOf([post(2)])).size).toBe(0);
  });
});

describe("recipeOf", () => {
  test("the audio template is a Captivate player of the field it reads, gated, with the two echoes", () => {
    const recipe = recipeFor(siteWith(), "episode-audio-embed")!;
    expect(recipe).toMatchObject({
      kind: "captivate-player",
      field: "captivate_episode",
      gated: true,
      meta: { id: "cfm_episode_id", media: "cfm_episode_media_url" },
    });
    expect(recipe.html).toHaveLength(2);
    expect(recipe.html[0]).toContain('src="https://player.captivate.fm/episode/{$cfm_episode_id}"');
    expect(recipe.html[0]).toContain('style="width: 100%;');
    expect(recipe.html[1]).toBe(
      '<a href="{$cfm_download_url}" target="_blank" rel="noopener noreferrer" download>Download Audio</a>',
    );
  });

  test("the video template is a YouTube embed of the field it reads", () => {
    const recipe = recipeFor(siteWith(), "no-slug")!;
    expect(recipe).toMatchObject({ kind: "youtube-field", field: "youtube", gated: true });
    expect(recipe.html).toHaveLength(1);
    expect(recipe.html[0]).toContain("//www.youtube-nocookie.com/embed/{$youtube_id}?rel=0");
  });

  test("a template that is arbitrary PHP, or has no echo of an iframe, or reads no field, is not a recipe", () => {
    const def = (code: string) => ({ slug: "x", title: "x", postId: 1, code });
    expect(recipeFor(siteWith(), "donor-dashboard-here")).toBeUndefined();
    expect(recipeFor(siteWith(), "missing")).toBeUndefined();
    expect(recipeOf(def("<?php echo 'hi';"))).toBeUndefined();
    expect(recipeOf(def(`<?php echo "<p>no frame</p>";`))).toBeUndefined();
    expect(
      recipeOf(def(`<?php echo "<iframe src=\\"https://x.test/{$id}\\"></iframe>";`)),
    ).toBeUndefined();
    // a template that echoes a link and no frame is not a player, however much else it looks like one
    expect(
      recipeOf(def(AUDIO_PHP.replace("<iframe", "<span").replace("</iframe>", "</span>"))),
    ).toBeUndefined();
    // a Captivate player whose meta keys are not the ones the recipe knows is not carried over
    expect(recipeOf(def(AUDIO_PHP.replaceAll("cfm_episode_media_url", "other")))).toBeUndefined();
    // a template that does not gate has no gate
    const open = AUDIO_PHP.replace("current_user_can( 'read_premium_content' )", "true");
    expect(recipeOf(def(open))?.gated).toBe(false);
  });
});

describe("youtubeId", () => {
  test("the id of every address shape the template reads, and nothing for any other text", () => {
    for (const address of [
      "https://www.youtube.com/watch?v=922QNv2JBFo",
      "https://youtu.be/922QNv2JBFo",
      "https://www.youtube.com/watch?feature=share&v=922QNv2JBFo&t=3",
      "https://www.youtube.com/embed/922QNv2JBFo",
      "https://youtube.com/shorts/922QNv2JBFo",
    ]) {
      expect(youtubeId(address)).toBe("922QNv2JBFo");
    }
    // A link field holds `{title, url, target}`: the address is its url.
    expect(youtubeId({ title: "", url: "https://youtu.be/922QNv2JBFo", target: "" })).toBe(
      "922QNv2JBFo",
    );
    expect(youtubeId({ title: "x", target: "" })).toBe("");
    expect(addressOf({ url: 5 })).toBe("");
    expect(addressOf("https://x.test")).toBe("https://x.test");
    expect(youtubeId("https://vimeo.com/123")).toBe("");
    expect(youtubeId(undefined)).toBe("");
    expect(youtubeId(42)).toBe("");
  });
});

describe("recipeData", () => {
  const withEpisode = (premium: string) =>
    siteWith(
      {
        50: { captivate_episode: ["51"], premium: [premium] },
        51: { cfm_episode_id: ["6eea7228"], cfm_episode_media_url: ["https://pod.test/a.mp3"] },
      },
      [post(50, { type: "episode" }), post(51, { type: "captivate_podcast" })],
    );

  test("an episode that names a podcast post with a Captivate id carries the id and the download address", () => {
    const model = withEpisode("0");
    expect(recipeData(model, model.posts.get(50)!)).toEqual({
      captivate: { episodeId: "6eea7228", downloadUrl: "https://pod.test/a.mp3?download=1" },
    });
  });

  test("a gated episode carries nothing of the media, and neither does a post with no episode or no id", () => {
    const gated = withEpisode("1");
    expect(gatedPost(gated, gated.posts.get(50)!)).toBe(true);
    expect(recipeData(gated, gated.posts.get(50)!)).toEqual({});
    const model = withEpisode("0");
    expect(recipeData(model, model.posts.get(51)!)).toEqual({});
    const noId = siteWith(
      {
        50: { captivate_episode: ["51"] },
        51: { cfm_episode_media_url: ["https://pod.test/a.mp3"] },
      },
      [post(50, { type: "episode" }), post(51, { type: "captivate_podcast" })],
    );
    expect(recipeData(noId, noId.posts.get(50)!)).toEqual({});
    const noMedia = siteWith(
      { 50: { captivate_episode: ["51"] }, 51: { cfm_episode_id: ["abc"] } },
      [post(50, { type: "episode" }), post(51, { type: "captivate_podcast" })],
    );
    expect(recipeData(noMedia, noMedia.posts.get(50)!)).toEqual({
      captivate: { episodeId: "abc" },
    });
  });

  test("a site that defines no such block has no data to carry", () => {
    const model = modelOf([post(50)], {
      50: { captivate_episode: ["51"] },
      51: { cfm_episode_id: ["x"] },
    });
    expect(recipeData(model, model.posts.get(50)!)).toEqual({});
  });
});
