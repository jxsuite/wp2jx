/**
 * The slider component a Cwicly query template becomes (`src/emit/slider.ts`): the instance's
 * properties from the block's options (the real ones of anabaptistperspectives' home page), and the
 * component in a real `jx build`.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { sliderComponent, sliderProps } from "../../src/emit/slider.ts";
import { buildJxProject, cleanupJxProjects, validateJxProject } from "../helpers/jx-build.ts";

setDefaultTimeout(120_000);
afterAll(cleanupJxProjects);

describe("the properties of an instance", () => {
  test("anabaptistperspectives' home slider: autoplay every three seconds, wrapping round", () => {
    // `repeaterSliderOptions` of page 819 as the editor stored it (the arrow icons left out)
    const options = { lg: { rewind: "true" }, autoplay: "true", interval: "3000" };
    expect(sliderProps(options)).toEqual({ autoplay: true, interval: 3000, rewind: true });
  });

  test("what the block leaves out is Splide's default, which the component holds", () => {
    expect(sliderProps(undefined)).toEqual({});
    expect(sliderProps({ autoplay: "false", interval: "soon" })).toEqual({ autoplay: false });
    expect(sliderProps({ lg: { autoplay: true, interval: 2500 } })).toEqual({
      autoplay: true,
      interval: 2500,
    });
    const state = sliderComponent("x-query-slider").state as Record<string, unknown>;
    expect([state.autoplay, state.interval, state.rewind]).toEqual([false, 5000, false]);
  });
});

describe("built by Jx", () => {
  test("the component and an instance around three items: the items in the track, the arrows and a dot each, and the project validates", async () => {
    const tag = "x-query-slider";
    const built = await buildJxProject(
      {
        "project.json": { name: "slider", url: "https://x.org" },
        [`components/${tag}.json`]: sliderComponent(tag),
        "pages/index.json": {
          title: "t",
          $elements: [{ $ref: `../components/${tag}.json` }],
          children: [
            {
              tagName: tag,
              $props: { autoplay: true, interval: 3000, rewind: true },
              children: ["One", "Two", "Three"].map((text) => ({
                tagName: "div",
                className: "cc-query-item",
                textContent: text,
              })),
            },
          ],
        },
      },
      { name: "slider" },
    );
    const html = built.html("/");
    expect([...html.matchAll(/class="cc-query-item"/g)]).toHaveLength(3);
    expect(html).toContain("splide__track");
    // the region is the element inside the host (the build writes no attribute of a component's root)
    expect(html).toMatch(
      /<div[^>]*class="[^"]*\bsplide\b[^"]*"[^>]*role="region"|role="region"[^>]*aria-roledescription="carousel"/,
    );
    expect(html).toContain('aria-roledescription="carousel"');
    expect([...html.matchAll(/class="[^"]*splide__arrow--(prev|next)/g)].map((m) => m[1])).toEqual([
      "prev",
      "next",
    ]);
    expect(built.list().some((f) => f === `components/${tag}.js`)).toBe(true);
    expect((await validateJxProject(built.dir)).problems).toEqual([]);
  });
});
