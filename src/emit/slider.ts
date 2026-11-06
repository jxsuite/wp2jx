/**
 * The slider a Cwicly query template is on the live page (`repeaterSlider`): Splide, a script of the
 * plugin's, shows one item at a time with arrows, a dot per item and, where the block says so,
 * autoplay. The converter puts the template's items in an instance of this component
 * (`cwicly/blocks/data.ts`, `queryTemplate`), and the project writes the component once, when a page
 * uses it ({@link sliderComponent}).
 *
 * The component keeps Splide's class names (`splide__track`, `splide__list`, `splide__arrow`,
 * `splide__pagination__page`, `is-active`), so the rules the site wrote for its slider still find
 * them. Its items are the light-DOM children of the instance (the slot), counted when it mounts; the
 * slides that are not shown are `inert`, so a keyboard does not tab into them. Autoplay pauses while
 * the slider is hovered or focused or the tab is hidden, and is off for a visitor who asks for reduced
 * motion. The built element calls `onMount` with the state alone (the element is `this`), and the
 * runtime with the state and the element: `host ?? this` reads both.
 */

/** What an instance says, from the block's `repeaterSliderOptions` (Splide's options, as text). */
export interface SliderProps {
  autoplay?: boolean;
  /** Milliseconds between slides when autoplaying (Splide: 5000). */
  interval?: number;
  /** Past the last slide is the first, and before the first the last (Splide: `rewind`, off). */
  rewind?: boolean;
}

const truthy = (v: unknown): boolean => v === true || v === "true" || v === 1 || v === "1";

/**
 * The instance's properties from the block's options: `autoplay`, `interval` and `rewind`, at the top
 * level or under the large breakpoint (`lg`), where the editor puts what applies at every width. What
 * the block leaves out is Splide's default, which the component's state holds.
 */
export function sliderProps(options: unknown): SliderProps {
  const o = (typeof options === "object" && options !== null ? options : {}) as Record<
    string,
    unknown
  >;
  const lg = (typeof o.lg === "object" && o.lg !== null ? o.lg : {}) as Record<string, unknown>;
  const read = (key: string): unknown => o[key] ?? lg[key];
  const out: SliderProps = {};
  if (read("autoplay") !== undefined) out.autoplay = truthy(read("autoplay"));
  const interval = Number(read("interval"));
  if (Number.isFinite(interval) && interval > 0) out.interval = interval;
  if (read("rewind") !== undefined) out.rewind = truthy(read("rewind"));
  return out;
}

/** Splide's own arrow, turned for the previous one. */
const ARROW = (flip: boolean): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" aria-hidden="true" focusable="false"${flip ? ' style="transform: scaleX(-1)"' : ""}><path d="m15.5 0.932-4.3 4.38 14.5 14.6-14.5 14.5 4.3 4.4 14.6-14.6 4.4-4.3-4.4-4.4-14.6-14.6z"></path></svg>`;

/** The next index, or the same one at the end of a slider that does not wrap. */
const STEP = (by: string): string =>
  `if (state.count > 0) { const to = state.index + ${by}; state.index = state.rewind ? (to + state.count) % state.count : Math.min(Math.max(to, 0), state.count - 1); }`;

/** The component, `components/<tag>.json`. */
export function sliderComponent(tag: string): Record<string, unknown> {
  const arrow = (side: "prev" | "next"): Record<string, unknown> => ({
    tagName: "button",
    className: `splide__arrow splide__arrow--${side}`,
    attributes: {
      type: "button",
      "aria-label": side === "prev" ? "Previous slide" : "Next slide",
      hidden: "${state.count < 2}",
      disabled:
        side === "prev"
          ? "${!state.rewind && state.index === 0}"
          : "${!state.rewind && state.index >= state.count - 1}",
    },
    onclick: { $ref: `#/state/${side}` },
    innerHTML: ARROW(side === "prev"),
  });
  return {
    tagName: tag,
    description:
      "One slide at a time from the items it is given, with previous and next arrows, a dot per item, and autoplay that pauses while hovered or focused and stays off for reduced motion. The Splide slider of a Cwicly query template, without its script.",
    state: {
      label: "Slides",
      autoplay: false,
      interval: 5000,
      rewind: false,
      index: 0,
      count: 0,
      dots: "${Array.from({ length: state.count }, (_, i) => i)}",
      prev: { $prototype: "Function", body: STEP("-1") },
      next: { $prototype: "Function", body: STEP("1") },
      goTo: { $prototype: "Function", body: "state.index = state.$map.item;" },
      onMount: {
        $prototype: "Function",
        arguments: ["state", "host"],
        body: [
          "const el = host ?? this;",
          // The list's own class is the build's to rename (its style is bound): the slides are the items under the track's list.
          "const slides = [...(el.querySelector('.splide__track')?.firstElementChild?.children ?? [])].filter((item) => item.classList.contains('cc-query-item'));",
          "state.count = slides.length;",
          "const mark = () => slides.forEach((slide, i) => { slide.inert = i !== state.index; });",
          "mark();",
          "el.addEventListener('transitionend', mark);",
          "el.addEventListener('click', () => queueMicrotask(mark));",
          "if (!state.autoplay || state.count < 2 || matchMedia('(prefers-reduced-motion: reduce)').matches) { return; }",
          "let paused = false;",
          "for (const [type, value] of [['mouseenter', true], ['mouseleave', false], ['focusin', true], ['focusout', false]]) { el.addEventListener(type, () => { paused = value; }); }",
          "const timer = setInterval(() => {",
          "if (paused || document.hidden) { return; }",
          "if (!state.rewind && state.index >= state.count - 1) { clearInterval(timer); return; }",
          "state.index = (state.index + 1) % state.count; mark();",
          "}, state.interval);",
        ].join(" "),
      },
    },
    style: {
      display: "block",
      boxSizing: "border-box",
      flex: "1 1 100%",
      width: "100%",
      minWidth: "0",
      // The slides side by side are as wide as all of them: the slider's own width is its container's.
      contain: "inline-size",
      "& .splide__arrow": {
        position: "absolute",
        top: "50%",
        transform: "translateY(-50%)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: "2rem",
        height: "2rem",
        padding: "0",
        border: "0",
        borderRadius: "50%",
        backgroundColor: "#fff",
        opacity: "0.7",
        cursor: "pointer",
        zIndex: "1",
        "& svg": { width: "0.9rem", height: "0.9rem", fill: "currentColor" },
        "&:hover": { opacity: "1" },
        "&:disabled": { opacity: "0.3", cursor: "default" },
        "&[hidden]": { display: "none" },
        "@--sm": { display: "none" },
      },
      "& .splide__arrow--prev": { left: "0" },
      "& .splide__arrow--next": { right: "0" },
      "& .splide__pagination__page": {
        width: "0.5rem",
        height: "0.5rem",
        padding: "0",
        border: "0",
        borderRadius: "50%",
        backgroundColor: "currentColor",
        opacity: "0.3",
        cursor: "pointer",
        "&.is-active": { opacity: "1", transform: "scale(1.3)" },
      },
    },
    // The carousel's region is an element of its own, as Splide's `section.splide` is: the build
    // writes no attribute of a component's root element.
    children: [
      {
        tagName: "div",
        className: "splide",
        attributes: {
          role: "region",
          "aria-roledescription": "carousel",
          "aria-label": "${state.label}",
        },
        // The arrows sit in the region's side padding, beside the slides.
        style: { position: "relative", padding: "0 3rem", "@--sm": { padding: "0" } },
        children: [
          {
            tagName: "div",
            className: "splide__track",
            style: { overflow: "hidden" },
            children: [
              {
                tagName: "div",
                className: "splide__list",
                attributes: { "aria-live": "${state.autoplay ? 'off' : 'polite'}" },
                style: {
                  display: "flex",
                  transform: "translateX(${-100 * state.index}%)",
                  transition: "transform 0.6s ease",
                  "& .cc-query-item": {
                    flex: "0 0 100%",
                    display: "flex",
                    justifyContent: "center",
                    minWidth: "0",
                  },
                  "@(prefers-reduced-motion: reduce)": { transition: "none" },
                },
                children: [{ tagName: "slot" }],
              },
            ],
          },
          arrow("prev"),
          arrow("next"),
          {
            tagName: "div",
            className: "splide__pagination",
            style: {
              display: "flex",
              justifyContent: "center",
              gap: "0.5rem",
              marginTop: "1.5rem",
            },
            children: [
              {
                $prototype: "Array",
                items: { $ref: "#/state/dots" },
                map: {
                  tagName: "button",
                  className:
                    "splide__pagination__page${$map.item === state.index ? ' is-active' : ''}",
                  attributes: {
                    type: "button",
                    "aria-label": "Go to slide ${$map.item + 1}",
                    "aria-current": "${$map.item === state.index ? 'true' : false}",
                  },
                  onclick: { $ref: "#/state/goTo" },
                },
              },
            ],
          },
        ],
      },
    ],
  };
}
