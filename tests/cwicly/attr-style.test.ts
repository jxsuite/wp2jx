import { beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { attrStyle, attrStyleDetailed, blockDefaults } from "../../src/cwicly/attr-style.ts";
import type { ConvertCtx, JxStyle } from "../../src/types.ts";
import { walkBlocks } from "../../src/wp/blocks.ts";
import {
  allSubjects,
  loadSite,
  makeCtx,
  subjectBlocks,
  type LoadedSite,
  type SiteName,
} from "../helpers/ctx.ts";

setDefaultTimeout(60_000);

let fl: ConvertCtx;
let ap: ConvertCtx;

beforeAll(async () => {
  fl = await makeCtx("fineline", { kind: "post", id: 5246 });
  ap = await makeCtx("ap", { kind: "post", id: 819 });
});

/** The style a set of attributes compiles to on fineline (main breakpoint `lg`, `md` and `sm` below it). */
const fineline = (attrs: Record<string, unknown>, blockName?: string): JxStyle =>
  attrStyle(attrs, fl, blockName ? { blockName, classID: "c" } : { classID: "c" });

describe("spacing", () => {
  test("four equal sides collapse to one value, as the editor writes the shorthand", () => {
    expect(
      fineline({
        paddingTop: { lg: "10px" },
        paddingRight: { lg: "10px" },
        paddingBottom: { lg: "10px" },
        paddingLeft: { lg: "10px" },
      }),
    ).toEqual({ padding: "10px" });
  });

  test("top equal to bottom and left to right is two values", () => {
    expect(
      fineline({
        marginTop: { lg: "5px" },
        marginBottom: { lg: "5px" },
        marginLeft: { lg: "0px" },
        marginRight: { lg: "0px" },
      }),
    ).toEqual({ margin: "5px 0px" });
  });

  test("a differing top with equal left and right is three values, top then sides then bottom", () => {
    expect(
      fineline({
        paddingTop: { lg: "1px" },
        paddingBottom: { lg: "3px" },
        paddingLeft: { lg: "2px" },
        paddingRight: { lg: "2px" },
      }),
    ).toEqual({ padding: "1px 2px 3px" });
  });

  test("four different sides are written top right bottom left", () => {
    expect(
      fineline({
        marginTop: { lg: "1px" },
        marginRight: { lg: "2px" },
        marginBottom: { lg: "3px" },
        marginLeft: { lg: "4px" },
      }),
    ).toEqual({ margin: "1px 2px 3px 4px" });
  });

  test("fewer than four sides are longhands, written top, bottom, right, left", () => {
    const style = fineline({
      marginLeft: { lg: "4px" },
      marginTop: { lg: "1px" },
      marginRight: { lg: "3px" },
    });
    expect(Object.entries(style)).toEqual([
      ["marginTop", "1px"],
      ["marginRight", "3px"],
      ["marginLeft", "4px"],
    ]);
  });

  test("an empty side does not count, and zero is a value only as a string", () => {
    expect(fineline({ marginTop: { lg: "" }, marginLeft: { lg: "0px" } })).toEqual({
      marginLeft: "0px",
    });
  });

  test("scroll margin has its own property", () => {
    expect(fineline({ scrollMarginTop: { lg: "3rem" } })).toEqual({ scrollMarginTop: "3rem" });
  });
});

describe("border, radius and shadow", () => {
  test("radius sides map to corners the editor's way: top is top-left, right is top-right, bottom is bottom-right", () => {
    expect(
      fineline({
        radiusTop: { lg: "1px" },
        radiusRight: { lg: "2px" },
        radiusBottom: { lg: "3px" },
      }),
    ).toEqual({
      borderTopRightRadius: "2px",
      borderTopLeftRadius: "1px",
      borderBottomRightRadius: "3px",
    });
    expect(
      fineline({
        radiusTop: { lg: "20px" },
        radiusRight: { lg: "20px" },
        radiusBottom: { lg: "20px" },
        radiusLeft: { lg: "20px" },
      }),
    ).toEqual({ borderRadius: "20px" });
  });

  test("border widths, style and colour (a palette reference becomes the colour's variable)", () => {
    expect(
      fineline({
        borderWidthTop: { lg: "2px" },
        borderWidthBottom: { lg: "2px" },
        borderWidthLeft: { lg: "1px" },
        borderWidthRight: { lg: "1px" },
        borderStyle: { lg: "solid" },
        borderColor: { lg: "!var=2fy8x!" },
      }),
    ).toEqual({
      borderColor: "var(--cc-color-1)",
      borderWidth: "2px 1px",
      borderStyle: "solid",
    });
  });

  test("an empty array is no border width (the editor saves [] for an untouched side)", () => {
    expect(fineline({ borderWidthTop: [], borderWidthLeft: [] })).toEqual({});
  });

  test("outline colour, width, style and offset", () => {
    expect(
      fineline({
        outlineColor: { lg: "#f00" },
        outlineWidth: { lg: "2px" },
        outlineStyle: { lg: "dashed" },
        outlineOffset: { lg: "3px" },
      }),
    ).toEqual({
      outlineColor: "#f00",
      outlineWidth: "2px",
      outlineOffset: "3px",
      outlineStyle: "dashed",
    });
  });

  test("box shadows: outer and inner, numbers are pixels, a shadow missing a part is skipped", () => {
    expect(
      fineline({
        borderOuterShadow: {
          lg: [
            { vertical: "5px", horizontal: "-5px", spread: "0px", blur: "5px", color: "#141c3b9e" },
            { vertical: "1px", horizontal: "1px", blur: "2px", color: "#000" },
          ],
        },
        borderInnerShadow: {
          lg: [{ vertical: 1, horizontal: 2, blur: 3, spread: 0, color: "red" }],
        },
      }),
    ).toEqual({
      boxShadow: "-5px 5px 5px 0px #141c3b9e,inset 2px 1px 3px 0px red",
    });
  });

  test("a single-value shadow is written as typed", () => {
    expect(
      fineline({ borderOuterShadow: { lg: [{ isSingle: true, single: "0 0 4px red" }] } }),
    ).toEqual({
      boxShadow: "0 0 4px red",
    });
  });
});

describe("layout", () => {
  test("flex: direction (with reverse), wrap, alignment, gaps, grow, shrink, basis, order", () => {
    expect(
      fineline({
        containerLayoutDisplay: { lg: "flex" },
        containerLayoutFlexDirection: { lg: "row" },
        containerLayoutFlexDirectionReverse: { lg: true },
        containerLayoutChildren: { lg: "wrap" },
        containerLayoutAlignItems: { lg: "center" },
        containerLayoutJustifyContent: { lg: "space-between" },
        containerLayoutFlexRowGap: { lg: "1rem" },
        containerLayoutFlexColumnGap: { lg: "2rem" },
        containerLayoutFlexGrow: { lg: "1" },
        containerLayoutFlexShrink: { lg: "0" },
        containerLayoutFlexBasis: { lg: "25%" },
        containerLayoutFlexOrder: { lg: "2" },
      }),
    ).toEqual({
      alignItems: "center",
      justifyContent: "space-between",
      flexShrink: "0",
      flexGrow: "1",
      flexBasis: "25%",
      rowGap: "1rem",
      columnGap: "2rem",
      order: "2",
      display: "flex",
      flexDirection: "row-reverse",
      flexWrap: "wrap",
    });
  });

  test("position offsets skip a bare unit (what the editor saves while the field is being typed)", () => {
    expect(
      fineline({
        containerLayoutPositionTop: { lg: "px" },
        containerLayoutPositionLeft: { lg: "-70px" },
        containerLayoutPositionRight: { lg: "rem" },
        containerLayoutPositionBottom: { lg: "0" },
        containerLayoutZIndex: { lg: "20" },
      }),
    ).toEqual({ zIndex: "20", bottom: "0", left: "-70px" });
  });

  test("overflow scroll-x and scroll-y are single-axis", () => {
    expect(
      fineline({ containerLayoutOverflow: { lg: "scroll-y", md: "scroll-x", sm: "hidden" } }),
    ).toEqual({
      overflowY: "scroll",
      "@--md": { overflowX: "scroll" },
      "@--sm": { overflow: "hidden" },
    });
  });

  test("grid: templates (repeat, minmax, plain), auto tracks, and per-item placement", () => {
    const style = fineline({
      containerLayoutGridTemplateColumns: {
        lg: [
          { value: "1fr", id: "a" },
          { value: "x", type: "minmax", min: "100px", max: "1fr", id: "b" },
          { autoSize: "auto-fit", type: "minmax", min: "10px", max: "20px", id: "c" },
        ],
      },
      containerLayoutGridTemplateRows: { lg: [{ value: "auto", id: "d" }] },
      containerLayoutGridAutoFlow: { lg: "row dense" },
      containerLayoutGridTemplateItems: {
        lg: [{ position: [1, 1, 2, 2] }, { specific: "hero" }],
      },
    });
    expect(style).toMatchObject({
      gridTemplateColumns: "1fr minmax(100px,1fr) repeat(auto-fit,minmax(10px,20px))",
      gridTemplateRows: "auto",
      gridAutoFlow: "row dense",
      "& :nth-child(1)": { gridColumn: "1 / 2", gridRow: "1 / 2" },
      "& :nth-child(2)": { gridArea: "hero" },
    });
  });

  test("named grid areas are written as the editor's matrix", () => {
    expect(
      fineline({
        containerLayoutGridTemplateRows: { lg: [{ value: "auto" }, { value: "auto" }] },
        containerLayoutGridTemplateColumns: { lg: [{ value: "1fr" }, { value: "1fr" }] },
        containerLayoutGridTemplateAreas: {
          lg: [
            { position: [1, 1, 2, 3], name: "head" },
            { position: [2, 1, 3, 2], name: "side" },
          ],
        },
      }),
    ).toMatchObject({ gridTemplateAreas: '"head head" "side ."' });
  });
});

describe("sizing", () => {
  test("width, height, min and max, aspect ratio, object fit", () => {
    expect(
      fineline({
        containerSizeWidth: { lg: "90%", sm: "100%" },
        containerSizeMaxWidth: { lg: "1366px" },
        containerSizeMinHeight: { lg: "50vh" },
        containerAspectRatio: { lg: "16/9" },
        containerObjectFit: { lg: "cover" },
      }),
    ).toEqual({
      minHeight: "50vh",
      width: "90%",
      maxWidth: "1366px",
      aspectRatio: "16/9",
      objectFit: "cover",
      "@--sm": { width: "100%" },
    });
  });

  test("an image's object fit comes from imageObjectFit at the main breakpoint only", () => {
    expect(fineline({ imageObjectFit: "contain" })).toEqual({ objectFit: "contain" });
  });
});

describe("typography", () => {
  test("colour, size, weight, spacing, line height, decoration, style, transform, stretch, alignment", () => {
    expect(
      fineline({
        fontTextColor: { lg: "#111" },
        fontSize: { lg: "1.1rem" },
        fontWeight: { lg: "600" },
        fontSpacing: { lg: "1px" },
        fontHeight: { lg: "1.2em" },
        fontDecoration: { lg: "none" },
        fontStyle: { lg: "italic" },
        fontTransform: { lg: "uppercase" },
        fontStretch: { lg: "condensed" },
        fontAlign: { lg: "center" },
        fontWhiteSpace: { lg: "nowrap" },
        fontWordBreak: { lg: "break-all" },
      }),
    ).toEqual({
      color: "#111",
      fontSize: "1.1rem",
      fontWeight: "600",
      letterSpacing: "1px",
      lineHeight: "1.2em",
      textDecoration: "none",
      fontStyle: "italic",
      textTransform: "uppercase",
      fontStretch: "condensed",
      textAlign: "center",
      whiteSpace: "nowrap",
      wordBreak: "break-all",
    });
  });

  test("a link colour is a rule on the block's links", () => {
    expect(
      fineline({ fontTextLinkColor: { lg: "!var=2fy8x!", lghover: "red" } }, "section"),
    ).toMatchObject({
      "& a": { color: "var(--cc-color-1)" },
      "&:hover a": { color: "red" },
    });
  });

  test("on a button or paragraph the link colour also reaches an anchor that is the block itself", () => {
    expect(fineline({ fontTextLinkColor: { lg: "red" } }, "paragraph")).toMatchObject({
      "&:is(a)": { color: "red" },
      "& a": { color: "red" },
    });
  });

  test("a family with a space is quoted and fallbacks follow it", () => {
    expect(fineline({ fontFamily: "Reem Kufi", fontFallbackFonts: ["serif"] })).toEqual({
      fontFamily: '"Reem Kufi", serif',
    });
    expect(fineline({ fontFamily: "Arial" })).toEqual({ fontFamily: "Arial" });
  });

  test("a font id is looked up in the site's fonts; one the site does not list is a note, not a guess", () => {
    const result = attrStyleDetailed({ fontFamily: "google-nope" }, fl, { classID: "c" });
    expect(result.style).toEqual({});
    expect(result.notes).toEqual(["fontFamily google-nope (a font this site does not list)"]);
    expect(attrStyle({ fontFamily: "google-source-sans-pro" }, fl, { classID: "c" })).toEqual({
      fontFamily: '"Source Sans Pro"',
    });
  });

  test("a fluid font size has no static value: it is a note", () => {
    const result = attrStyleDetailed(
      { fontSize: { lg: { type: "fluid", minFont: 1, maxFont: 2 } } },
      fl,
      {
        classID: "c",
      },
    );
    expect(result.style).toEqual({});
    expect(result.notes).toEqual(["fontSize (fluid)"]);
  });
});

describe("the small families", () => {
  test("variation settings: custom axes, the slant, and the width axis only while there is no font stretch", () => {
    expect(
      fineline({
        fontCustomAxes: { wdth: { lg: "75" }, wght: { lg: "500" } },
        fontSlant: { lg: "-5" },
      }),
    ).toEqual({ fontVariationSettings: "'wdth' 75, 'wght' 500, 'slnt' -5" });
    expect(
      fineline({ fontCustomAxes: { wdth: { lg: "75" } }, fontStretch: { lg: "condensed" } }),
    ).toEqual({ fontStretch: "condensed" });
  });

  test("align and justify, content and items and self", () => {
    expect(
      fineline({
        containerLayoutAlignContent: { lg: "space-between" },
        containerLayoutJustifyItems: { lg: "center" },
        containerLayoutJustifySelf: { lg: "end" },
        containerLayoutAlignSelf: { lg: "start" },
      }),
    ).toEqual({
      alignContent: "space-between",
      justifyItems: "center",
      alignSelf: "start",
      justifySelf: "end",
    });
  });

  test("blend mode, backface visibility (the -webkit twin is the reader's to collapse), object position", () => {
    expect(fineline({ effectsMixBlendMode: { lg: "multiply" } })).toEqual({
      mixBlendMode: "multiply",
    });
    expect(fineline({ transformsBackfaceVisibility: { lg: "hidden" } })).toEqual({
      backfaceVisibility: "hidden",
    });
    expect(fineline({ imageObjectPosition: { lg: "right top" } })).toEqual({
      objectPosition: "right top",
    });
  });

  test("svg stroke and fill (palette colours resolved), list style and column count on any block, button spacing, skeleton size", () => {
    expect(
      fineline({
        strokeWidth: { lg: "2" },
        iconFill: { lg: "red" },
        stroke: { lg: "!var=2fy8x!" },
      }),
    ).toEqual({ strokeWidth: "2", fill: "red", stroke: "var(--cc-color-1)" });
    expect(
      fineline({
        listStylePosition: { lg: "inside" },
        listStyleType: { lg: "square" },
        columnsCount: { lg: "3" },
      }),
    ).toEqual({ listStylePosition: "inside", listStyleType: "square", columnCount: "3" });
    expect(fineline({ buttonSpacing: { lg: "3" } })).toEqual({ columnGap: "3px" });
    expect(fineline({ skeletonSizeWidth: { lg: "10px" } })).toEqual({
      "--cc-skeleton-width": "10px",
    });
  });
});

describe("background", () => {
  test("colour, picture, size, position (focal point), repeat, attachment, blend, clip", () => {
    expect(
      fineline({
        backgroundColor: { lg: "#fff" },
        backgroundType: { lg: "image" },
        backgroundPictureURL: "https://x.test/a.png",
        backgroundSize: { lg: "cover" },
        backgroundFocalPoint: { lg: { x: 0.46, y: 0.5 } },
        backgroundRepeat: { lg: "no-repeat" },
        backgroundAttachment: { lg: "fixed" },
        backgroundBlendMode: { lg: "multiply" },
        backgroundClip: { lg: "text" },
      }),
    ).toEqual({
      backgroundImage: "url(https://x.test/a.png)",
      backgroundColor: "#fff",
      backgroundAttachment: "fixed",
      backgroundBlendMode: "multiply",
      backgroundClip: "text",
      backgroundSize: "cover",
      backgroundPosition: "46% 50%",
      backgroundRepeat: "no-repeat",
    });
  });

  test("manual size with only a height is auto by that height", () => {
    expect(fineline({ backgroundManualHeight: { lg: "1000px" } })).toEqual({
      backgroundSize: "auto 1000px",
    });
  });

  test("manual size uses the width and height fields", () => {
    expect(
      fineline({ backgroundSize: { lg: "manual" }, backgroundManualWidth: { lg: "2000px" } }),
    ).toEqual({ backgroundSize: "2000px auto" });
    expect(
      fineline({
        backgroundManualWidth: { lg: "2000px" },
        backgroundManualHeight: { lg: "1000px" },
      }),
    ).toEqual({ backgroundSize: "2000px 1000px" });
  });

  test("a gradient replaces the colour and goes before the picture", () => {
    expect(
      fineline({
        backgroundGradientSelected: { lg: true },
        backgroundGradientColor: { lg: "linear-gradient(red, blue)" },
        backgroundColor: { lg: "#fff" },
      }),
    ).toEqual({ backgroundImage: "linear-gradient(red, blue)" });
  });

  test("a dynamic picture is a custom property the page sets", () => {
    expect(
      fineline({
        backgroundImageType: "dynamic",
        backgroundDynamicWordpressType: "featuredimage",
      }),
    ).toEqual({ backgroundImage: "var(--background-image)" });
  });

  test("an overlay is a ::before that covers the block, its box written once", () => {
    const style = fineline({ backgroundOverlayColor: { lg: "#00000087", md: "#11111187" } });
    expect(style).toMatchObject({
      "::before": {
        position: "absolute",
        content: '""',
        top: "0",
        right: "0",
        left: "0",
        bottom: "0",
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        backgroundColor: "#00000087",
      },
      "@--md": { "::before": { backgroundColor: "#11111187" } },
    });
    expect(JSON.stringify(style["@--md"])).not.toContain("absolute");
  });

  test("a backdrop blur belongs to the overlay too, its -webkit twin collapsed by the reader", () => {
    expect(fineline({ backgroundBlur: { lg: "25" } })).toMatchObject({
      "::before": { backdropFilter: "blur(25px)", position: "absolute" },
    });
    expect(JSON.stringify(fineline({ backgroundBlur: { lg: "25" } }))).not.toContain("Webkit");
  });
});

describe("effects and transforms", () => {
  test("opacity zero is a value", () => {
    expect(fineline({ effectsOpacity: { lg: 0 } })).toEqual({ opacity: "0" });
    expect(fineline({ effectsOpacity: { lg: "" } })).toEqual({});
  });

  test("filters add their units, a drop shadow needs all its parts", () => {
    expect(
      fineline({
        effectsBlur: { lg: "4" },
        effectsBrightness: { lg: "1.3" },
        effectsContrast: { lg: "200" },
        effectsHueRotate: { lg: "103" },
        effectsDropShadow: { lg: { x: "5px", y: "5px", color: "!var=2fy8x!", blur: "5px" } },
      }),
    ).toEqual({
      // written with no space between functions, as the editor writes it
      filter:
        "blur(4px)brightness(1.3)contrast(200%)hue-rotate(103deg)drop-shadow(5px 5px 5px var(--cc-color-1))",
    });
    expect(
      fineline({ effectsDropShadow: { lg: { x: "5px", y: "", color: "red", blur: "5px" } } }),
    ).toEqual({});
  });

  test("text shadow fills missing parts with 0", () => {
    expect(
      fineline({ effectsTextShadowHorizontal: { lg: "2" }, effectsTextShadowColor: { lg: "red" } }),
    ).toEqual({ textShadow: "2px 0 0 red" });
  });

  test("a transition: the editor's list form and its single-property form", () => {
    // the list form is a `transition` shorthand, and the editor writes it on ::before as well
    expect(
      fineline({
        effectsTransition: {
          lg: [{ duration: "0.5", timing: "ease", property: "color", delay: "0.1" }],
        },
      }),
    ).toEqual({
      transition: "color 0.5s ease 0.1s",
      "::before": { transition: "color 0.5s ease 0.1s" },
    });
    expect(
      fineline({
        effectsTransitionDuration: { lg: "0.4" },
        effectsTransitionTiming: { lg: "ease-in" },
      }),
    ).toEqual({
      transitionDuration: "0.4s",
      transitionTimingFunction: "ease-in",
      "::before": { transitionDuration: "0.4s", transitionTimingFunction: "ease-in" },
    });
  });

  test("an animation's parts", () => {
    expect(
      fineline({
        effectsAnimationName: { lg: "fade-in" },
        effectsAnimationDuration: { lg: "1" },
        effectsAnimationFillMode: { lg: "forwards" },
      }),
    ).toEqual({ animationDuration: "1s", animationFillMode: "forwards", animationName: "fade-in" });
  });

  test("transforms need their control flag, and compose in the editor's order", () => {
    expect(fineline({ transformsScaleX: { lg: ".9" } })).toEqual({});
    expect(
      fineline({
        transformsScaleControl: true,
        transformsScaleX: { lg: ".9" },
        transformsScaleY: { lg: "1.1" },
        transformsTranslateControl: true,
        transformsTranslateX: { lg: "5px" },
        transformsRotateControl: true,
        transformsRotate: { lg: 45 },
        transformsOrigin: { lg: "top left" },
      }),
    ).toEqual({
      transform: "rotate(45deg)translateX(5px)scaleX(.9)scaleY(1.1)",
      transformOrigin: "top left",
    });
  });

  test("each transform has its own control: translate needs its flag as scale needs its", () => {
    expect(fineline({ transformsTranslateX: { lg: "5px" }, transformsScaleControl: true })).toEqual(
      {},
    );
    expect(
      fineline({ transformsTranslateX: { lg: "5px" }, transformsTranslateControl: true }),
    ).toEqual({
      transform: "translateX(5px)",
    });
  });

  test("a per-state control (…ControlSpec) decides for that state only", () => {
    expect(
      fineline({
        transformsScaleControlSpec: { lghover: true },
        transformsScaleX: { lghover: ".9" },
        transformsScaleY: { lghover: ".9" },
      }),
    ).toEqual({ ":hover": { transform: "scaleX(.9)scaleY(.9)" } });
  });

  test("interaction properties", () => {
    expect(
      fineline({
        interactionsCursor: { lg: "pointer" },
        interactionsUserSelect: { lg: "none" },
        interactionsPointerEvents: { lg: "none" },
      }),
    ).toEqual({ cursor: "pointer", userSelect: "none", pointerEvents: "none" });
  });
});

describe("keys: breakpoints and pseudos", () => {
  test("the main breakpoint is unwrapped, the others are media queries, and an unknown key is ignored", () => {
    expect(fineline({ marginTop: { lg: "1px", md: "2px", sm: "3px", xl: "9px" } })).toEqual({
      marginTop: "1px",
      "@--md": { marginTop: "2px" },
      "@--sm": { marginTop: "3px" },
    });
  });

  test("a breakpoint listed before the main one is a min-width query, and gets its own @--key", () => {
    const wide: ConvertCtx = {
      ...fl,
      cwicly: {
        ...fl.cwicly,
        breakpoints: [
          { key: "xl", width: 1600, isMain: false, direction: "min" },
          ...fl.cwicly.breakpoints,
        ],
      },
    };
    const style = attrStyle({ marginTop: { xl: "1px", lg: "2px", md: "3px" } }, wide, {
      classID: "c",
    });
    expect(style).toEqual({
      marginTop: "2px",
      "@--xl": { marginTop: "1px" },
      "@--md": { marginTop: "3px" },
    });
    expect(attrStyleDetailed({ marginTop: { xl: "1px" } }, wide, { classID: "c" }).css).toBe(
      "@media screen and (min-width: 1600px){.c{margin-top:1px;}}",
    );
  });

  test("a classID that is not a plain identifier is escaped in the CSS and is still the class the rules belong to", () => {
    const result = attrStyleDetailed({ marginTop: { lg: "1px" } }, fl, { classID: "a.b:c" });
    expect(result.css).toBe(".a\\.b\\:c{margin-top:1px;}");
    expect(result.style).toEqual({ marginTop: "1px" });
  });

  test("a pseudo follows the breakpoint: hover, active, focus, and ::before / ::after", () => {
    expect(
      fineline({
        marginTop: { lghover: "1px", mdhover: "2px" },
        paddingTop: { lgactive: "3px", lgfocus: "4px" },
        fontSize: { smbefore: "5px", lgafter: "6px" },
      }),
    ).toEqual({
      ":hover": { marginTop: "1px" },
      ":active": { paddingTop: "3px" },
      ":focus": { paddingTop: "4px" },
      "::after": { fontSize: "6px" },
      "@--md": { ":hover": { marginTop: "2px" } },
      "@--sm": { "::before": { fontSize: "5px" } },
    });
  });

  test("a block's own pseudos (pseudoClasses) become pseudo-classes", () => {
    expect(
      fineline({ pseudoClasses: ["focus-within"], marginTop: { "lgfocus-within": "1px" } }),
    ).toEqual({ ":focus-within": { marginTop: "1px" } });
  });

  test("::before content is written once from pseudoContent", () => {
    expect(fineline({ pseudoContent: { before: '""' } })).toEqual({
      "::before": { content: '""' },
    });
  });
});

describe("defaults", () => {
  test("a section with nothing saved still has the block type's position and display", () => {
    expect(attrStyle({}, fl, { blockName: "cwicly/section", classID: "c" })).toEqual({
      position: "relative",
      display: "flex",
    });
    expect(attrStyle({}, fl, { blockName: "cwicly/heading", classID: "c" })).toEqual({
      position: "relative",
      display: "block",
    });
  });

  test("what the comment carries replaces the default as a whole, an empty one turns it off", () => {
    expect(
      attrStyle({ containerLayoutDisplay: { lg: "" } }, fl, { blockName: "section", classID: "c" }),
    ).toEqual({ position: "relative" });
    expect(
      attrStyle({ containerLayoutDisplay: { sm: "none" } }, fl, {
        blockName: "section",
        classID: "c",
      }),
    ).toEqual({ position: "relative", "@--sm": { display: "none" } });
  });

  test("an image is full width and automatic height unless told otherwise", () => {
    expect(attrStyle({}, fl, { blockName: "image", classID: "c" })).toEqual({
      position: "relative",
      display: "block",
      height: "auto",
      width: "100%",
    });
  });

  test("with the site's cwiclyDefaults off the plugin strips these defaults (the built-in classes carry them)", () => {
    expect(ap.cwicly.optimise.cwiclyDefaults).toBe(false);
    expect(attrStyle({}, ap, { blockName: "section", classID: "c" })).toEqual({});
    expect(attrStyle({}, ap, { blockName: "image", classID: "c" })).toEqual({});
    expect(blockDefaults("image", false)).toEqual({});
    expect(blockDefaults("image", true)).toMatchObject({ containerSizeWidth: { lg: "100%" } });
    // the grid blocks keep their display and columns template: only the gaps are stripped
    expect(blockDefaults("query-template", false)).toMatchObject({
      containerLayoutDisplay: { lg: "grid" },
      columnsTemplateColumns: { lg: "3" },
    });
    expect(blockDefaults("query-template", false)).not.toHaveProperty("columnsRowGap");
  });

  test("the plugin matches `cwicly/slide` as a substring, so the slider and its slides lose the defaults too", () => {
    expect(blockDefaults("sliderchild", true)).toMatchObject({
      containerSizeWidth: { lg: "100%" },
      containerSizeHeight: { lg: "100%" },
    });
    expect(blockDefaults("sliderchild", false)).not.toHaveProperty("containerSizeWidth");
    expect(blockDefaults("sliderchild", false)).not.toHaveProperty("containerSizeHeight");
    expect(blockDefaults("slider", true)).toHaveProperty("containerSizeWidth");
    expect(blockDefaults("slider", false)).not.toHaveProperty("containerSizeWidth");
    // the rest of the slider's defaults are not size, and stay
    expect(blockDefaults("slider", false)).toMatchObject({ sliderNumberPerWindow: { lg: 3 } });
  });

  test("a block type nothing is known about has no defaults", () => {
    expect(blockDefaults("nonesuch")).toEqual({});
    expect(
      attrStyle({ marginTop: { lg: "1px" } }, fl, { blockName: "cwicly/nonesuch", classID: "c" }),
    ).toEqual({
      marginTop: "1px",
    });
  });
});

describe("columns, gallery and lists", () => {
  test("a columns block with its default control takes the columns from columnsAutoItems", () => {
    expect(
      attrStyle(
        {
          columnsTemplateColumns: { lg: "3" },
          columnsAutoItems: { lg: [{ w: 1 }, { w: 2 }, { w: 1 }] },
        },
        fl,
        { blockName: "columns", classID: "c" },
      ),
    ).toMatchObject({
      position: "relative",
      display: "grid",
      gridTemplateColumns: "1fr 2fr 1fr",
      gridAutoRows: "minmax(100px, auto)",
      rowGap: "10px",
      columnGap: "10px",
    });
  });

  test("without control, columns repeat evenly and each item has a placement rule", () => {
    const style = attrStyle(
      {
        columnsControl: false,
        columnsTemplateColumns: { lg: "2" },
        columnsItems: {
          lg: [
            { x: 0, y: 0, w: 1, h: 1 },
            { x: 1, y: 0, w: 1, h: 2 },
          ],
        },
      },
      fl,
      { blockName: "columns", classID: "c" },
    );
    expect(style).toMatchObject({
      gridTemplateColumns: "repeat(2, 1fr)",
      "& > div:nth-of-type(1)": { gridColumn: "1 / 2", gridRow: "1 / 2" },
      "& > div:nth-of-type(2)": { gridColumn: "2 / 3", gridRow: "1 / 3" },
    });
  });

  test("auto-fit columns, with the minimum width as a pixel length", () => {
    expect(
      attrStyle(
        {
          columnsAutoTemplateControl: true,
          columnsMinimumColumnsWidth: { lg: 250 },
        },
        fl,
        { blockName: "columns", classID: "c" },
      ),
    ).toMatchObject({ gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))" });
  });

  test("a query template lays out as a grid only when its display is grid", () => {
    const flex = attrStyle({ containerLayoutDisplay: { lg: "flex" } }, fl, {
      blockName: "query-template",
      classID: "c",
    });
    expect(flex).not.toHaveProperty("gridTemplateColumns");
    expect(
      attrStyle({ columnsAutoItems: { lg: [{ w: 1 }, { w: 1 }] } }, fl, {
        blockName: "query-template",
        classID: "c",
      }),
    ).toMatchObject({ display: "grid", gridTemplateColumns: "1fr 1fr" });
  });

  test("a gallery's grid sits on .cc-gallery, its height is a custom property", () => {
    expect(attrStyle({}, fl, { blockName: "gallery", classID: "c" })).toMatchObject({
      "--cc-gallery-height": "300px",
      "& .cc-gallery": {
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
        columnGap: "10px",
        rowGap: "10px",
      },
    });
  });

  test("lists: bullets, positions, spacing, indent, columns", () => {
    expect(
      attrStyle(
        {
          listStyleUl: "square",
          listStyleOl: "decimal",
          listPosition: "inside",
          listSpacing: { lg: "16px" },
          listIndent: { lg: "1rem" },
          columnsCount: { lg: "2" },
        },
        fl,
        { blockName: "list", classID: "c" },
      ),
    ).toMatchObject({
      "& ul": { listStyleType: "square", listStylePosition: "inside", columnCount: "2" },
      "& ol": { listStyleType: "decimal", listStylePosition: "inside", columnCount: "2" },
      "& li": { paddingTop: "calc(16px/2)", paddingBottom: "calc(16px/2)" },
      "& ul > li": { marginLeft: "1rem" },
      "& ol > li": { marginLeft: "1rem" },
      "& ul ul li": { paddingTop: "16px !important", paddingBottom: "0 !important" },
    });
  });

  test("an icon list drops the bullets and masks an icon onto li::before", () => {
    const result = attrStyleDetailed(
      {
        listIconActive: true,
        listIconUnicode: "<svg/>",
        listIconColor: { lg: "red" },
        listIconSize: { lg: "20px" },
        listIconSpacing: { lg: "10px" },
      },
      fl,
      { blockName: "list", classID: "c" },
    );
    expect(result.style["& li"]).toMatchObject({ breakInside: "avoid" });
    expect(result.style).not.toHaveProperty("& ul");
    // two classes in the first compound: the reader files this one beside the class's tree
    expect(result.other.get(".c.cc-icon-list li::before")).toMatchObject({
      position: "relative",
      content: '""',
      backgroundColor: "red",
      marginRight: "10px",
      fontSize: "20px",
      minWidth: "20px",
      minHeight: "20px",
    });
  });

  test("icon and button svg sizes; a column's order", () => {
    expect(
      attrStyle({ iconSize: { lg: "1.25rem" } }, fl, { blockName: "icon", classID: "c" }),
    ).toMatchObject({
      "& svg": { height: "1.25rem", width: "1.25rem" },
    });
    expect(
      attrStyle({ buttonSize: { lg: "19px" } }, fl, { blockName: "button", classID: "c" }),
    ).toMatchObject({
      "& svg": { height: "19px", width: "19px" },
    });
    expect(
      attrStyle({ columnOrder: { lg: "3" } }, fl, { blockName: "column", classID: "c" }),
    ).toMatchObject({
      order: "3",
    });
  });
});

describe("relative styles and variants", () => {
  const rel = (rules: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    relativeStyles: [{ name: "r", id: "R1", rules }],
    ...extra,
  });

  test("a relative style is a rule on a descendant: class, tag, attribute, universal", () => {
    expect(
      attrStyle(
        rel([{ selectorType: "class", selector: "item", combinator: " " }], {
          fontSize: { rslgR1: "2rem" },
        }),
        fl,
        { classID: "c" },
      ),
    ).toEqual({ "& .item": { fontSize: "2rem" } });
    expect(
      attrStyle(
        rel(
          [
            { selectorType: "type", selector: "li", combinator: " > " },
            { selectorType: "attribute", selector: 'data-x="1"', combinator: "" },
          ],
          { fontSize: { rslgR1: "2rem" } },
        ),
        fl,
        { classID: "c" },
      ),
    ).toEqual({ '& > li[data-x="1"]': { fontSize: "2rem" } });
    expect(
      attrStyle(
        rel([{ selectorType: "*", combinator: " > " }], {
          opacity: 1,
          effectsOpacity: { rslgR1: "0" },
        }),
        fl,
        {
          classID: "c",
        },
      ),
    ).toEqual({ "& > *": { opacity: "0" } });
  });

  test("its states go on the block, then the descendant: .c:hover .item", () => {
    expect(
      attrStyle(
        rel([{ selectorType: "class", selector: "item", combinator: " " }], {
          fontTextColor: { rslgR1hover: "red", rsmdR1: "blue" },
        }),
        fl,
        { classID: "c" },
      ),
    ).toEqual({
      "&:hover .item": { color: "red" },
      "@--md": { "& .item": { color: "blue" } },
    });
  });

  test("a comma starts another selector on the block, and a pseudo applies to each", () => {
    expect(
      attrStyle(
        rel(
          [
            { selectorType: "class", selector: "a", combinator: " " },
            { combinator: " , " },
            { selectorType: "pseudoclasses", selector: ":hover", combinator: "" },
          ],
          { fontSize: { rslgR1: "1px" } },
        ),
        fl,
        { classID: "c" },
      ),
    ).toEqual({ "& .a": { fontSize: "1px" }, ":hover": { fontSize: "1px" } });
  });

  test("a custom rule: .blockclass is the block, :pseudos is where the state goes", () => {
    const attrs = {
      relativeStyles: [
        { name: "n", id: "N1", customRule: ".blockclass:not([is-modal=true]) .inner:pseudos" },
      ],
      fontTextColor: { rslgN1: "red", rslgN1hover: "blue" },
    };
    expect(attrStyle(attrs, fl, { classID: "c" })).toEqual({
      "&:not([is-modal=true]) .inner": { color: "red" },
      "&:not([is-modal=true]) .inner:hover": { color: "blue" },
    });
  });

  test("a hidden relative style is not written", () => {
    expect(
      attrStyle(
        {
          relativeStyles: [
            {
              id: "R1",
              visibility: true,
              rules: [{ selectorType: "class", selector: "x", combinator: " " }],
            },
          ],
          fontSize: { rslgR1: "2rem" },
        },
        fl,
        { classID: "c" },
      ),
    ).toEqual({});
  });

  test("the author's own CSS for a relative style takes .relativestyle for its selector, only if the written text is there", () => {
    const base = {
      relativeStyles: [
        { id: "R1", rules: [{ selectorType: "class", selector: "x", combinator: " " }] },
      ],
      customSCSSExtras: { rslgR1: ".relativestyle::after{position:absolute}" },
    };
    expect(
      attrStyle(
        { ...base, customCSSExtras: { rslgR1: ".relativestyle::after { position: absolute }" } },
        fl,
        {
          classID: "c",
          scssCompiler: true,
        },
      ),
    ).toEqual({ "& .x::after": { position: "absolute" } });
    // written text absent: the editor tests it first, so nothing is printed
    expect(
      attrStyle({ ...base, customCSSExtras: { rslgR1: "" } }, fl, {
        classID: "c",
        scssCompiler: true,
      }),
    ).toEqual({});
  });

  test("with the SCSS option on, the compiled extras are what is printed; with it off, the written text", () => {
    const attrs = {
      relativeStyles: [
        { id: "R1", rules: [{ selectorType: "class", selector: "x", combinator: " " }] },
      ],
      customCSSExtras: { rslgR1: ".relativestyle::after { position: absolute }" },
      customSCSSExtras: { rslgR1: ".relativestyle::after{position:fixed}" },
    };
    expect(attrStyle(attrs, fl, { classID: "c", scssCompiler: true })).toEqual({
      "& .x::after": { position: "fixed" },
    });
    expect(attrStyle(attrs, fl, { classID: "c", scssCompiler: false })).toEqual({
      "& .x::after": { position: "absolute" },
    });
  });

  test("a relative style's icon colour and size are rules on its svg", () => {
    expect(
      attrStyle(
        {
          relativeStyles: [
            { id: "R1", rules: [{ selectorType: "class", selector: "x", combinator: " " }] },
          ],
          relativeStylesIconColor: { rslgR1: "red" },
          relativeStylesIconSize: { rslgR1: "2rem" },
        },
        fl,
        { classID: "c" },
      ),
    ).toEqual({ "& .x svg": { color: "red", height: "2rem", width: "2rem" } });
  });

  test("a component variant's keys are rules on .classID.cs-<id>, given the variant ids", () => {
    const attrs = { containerSizeWidth: { cslgV1: "50%", csmdV1: "100%" } };
    const given = attrStyleDetailed(attrs, fl, { classID: "c", variants: ["V1"] });
    // two classes in the first compound: filed beside the tree, where the CSS reader files it too
    expect(given.other.get(".c.cs-V1")).toEqual({ width: "50%", "@--md": { width: "100%" } });
    expect(attrStyleDetailed(attrs, fl, { classID: "c" }).other.size).toBe(0);
  });
});

describe("relative styles that name another block", () => {
  const HEADING_RED = "1c1d4c60-d810-4417-a420-84d30ba33f83";
  const UID = "0a1b2c3d-0000-4000-8000-000000000001";

  /** The real block of post 4775 (a published-page duplicate whose stylesheet the fixtures lack). */
  async function div(classID: string, id: number): Promise<Record<string, unknown>> {
    const site = await loadSite("fineline");
    let found: Record<string, unknown> | undefined;
    walkBlocks(subjectBlocks(site, { kind: "post", id }), (b) => {
      if (found === undefined && b.attrs.classID === classID) found = b.attrs;
    });
    return found!;
  }

  test("the selector is the target's uniqueID: with the block's classID it is the class the stylesheet has (div-c59edf1)", async () => {
    const attrs = await div("div-c59edf1", 4775);
    const real = (await makeCtx("fineline", { kind: "post", id: 5246 })).css.classes.get(
      "div-c59edf1",
    )!.style;
    const result = attrStyleDetailed(attrs, fl, {
      blockName: "cwicly/div",
      classID: "div-c59edf1",
      classOf: (uniqueID) => (uniqueID === HEADING_RED ? "heading-red" : undefined),
    });
    expect(result.style["& .heading-red"]).toEqual(real["& .heading-red"] as JxStyle);
    expect(result.style["&:hover .heading-red"]).toEqual(real["&:hover .heading-red"] as JxStyle);
    expect(result.unresolvedSelectors).toEqual([]);
  });

  test("an id nothing resolves is reported and never written as a class (it would be an invalid selector)", async () => {
    const attrs = await div("div-c59edf1", 4775);
    const result = attrStyleDetailed(attrs, fl, {
      blockName: "cwicly/div",
      classID: "div-c59edf1",
    });
    expect(result.unresolvedSelectors).toEqual([HEADING_RED]);
    expect(result.css).not.toContain(HEADING_RED);
    expect(Object.keys(result.style).some((k) => k.startsWith("&"))).toBe(false);
    // the block's own rules are all still there
    expect(result.style).toMatchObject({ color: "var(--color-kbvn1)", ":hover": {} });
  });

  test("a global class id is resolved to the class's name", () => {
    const [id, name] = [...fl.cwicly.globalClassNames][0]!;
    const result = attrStyleDetailed(
      {
        fontSize: { rslgR1: "2rem" },
        relativeStyles: [
          { id: "R1", rules: [{ selectorType: "class", selector: id, combinator: " " }] },
        ],
      },
      fl,
      { classID: "c" },
    );
    expect(result.style).toEqual({ [`& .${name}`]: { fontSize: "2rem" } });
  });

  test("a resolved class is escaped like any class name: one that starts with a digit stays a valid selector", () => {
    const result = attrStyleDetailed(
      {
        fontSize: { rslgR1: "2rem" },
        relativeStyles: [
          { id: "R1", rules: [{ selectorType: "class", selector: UID, combinator: " " }] },
        ],
      },
      fl,
      { classID: "c", classOf: () => "3col" },
    );
    expect(result.css).toContain(".c .\\33 col{");
    // the nested key keeps the escape: Jx writes the key as the selector it is
    expect(result.style).toEqual({ "& .\\33 col": { fontSize: "2rem" } });
  });

  test("a class an author typed is written as typed (the editor does the same), and is not looked up as a block id", () => {
    const seen: string[] = [];
    const result = attrStyleDetailed(
      {
        fontSize: { rslgR1: "2rem" },
        relativeStyles: [
          { id: "R1", rules: [{ selectorType: "class", selector: "item", combinator: " " }] },
        ],
      },
      fl,
      {
        classID: "c",
        classOf: (id) => {
          seen.push(id);
          return undefined;
        },
      },
    );
    expect(result.style).toEqual({ "& .item": { fontSize: "2rem" } });
    expect(result.unresolvedSelectors).toEqual([]);
    expect(seen).toEqual([]);
  });
});

describe("a classID that starts with a digit", () => {
  test("it is escaped, so the rules are still read (Jx's own scope selector cannot, which styleBlock reports)", () => {
    const result = attrStyleDetailed(
      { marginTop: { lg: "10px" }, backgroundColor: { lg: "red" } },
      fl,
      { classID: "3col" },
    );
    expect(result.css).toContain(".\\33 col{");
    expect(result.style).toEqual({ marginTop: "10px", backgroundColor: "red" });
  });

  test("a hyphen before the digit, and a lone hyphen, are escaped too", () => {
    expect(attrStyleDetailed({ marginTop: { lg: "1px" } }, fl, { classID: "-1a" }).css).toContain(
      ".-\\31 a{",
    );
    expect(attrStyleDetailed({ marginTop: { lg: "1px" } }, fl, { classID: "-" }).css).toContain(
      ".\\-{",
    );
  });
});

describe("masonry (repeaterMasonry)", () => {
  test("a masonry query template is equal tracks on `.cc-masonry`, as the stylesheet has it (ap's footer)", async () => {
    const site = await loadSite("ap");
    const ctx = await makeCtx("ap", { kind: "part", slug: "footer" });
    let seen = 0;
    walkBlocks(subjectBlocks(site, { kind: "part", slug: "footer" }), (block) => {
      if (block.attrs.classID !== "querytemplate-cf01409") return;
      seen++;
      const mine = attrStyleDetailed(block.attrs, ctx, {
        blockName: block.name ?? "",
        classID: "querytemplate-cf01409",
      });
      expect(mine.style).toEqual(ctx.css.classes.get("querytemplate-cf01409")!.style);
      expect(mine.other.get(".querytemplate-cf01409.cc-masonry")).toEqual(
        ctx.css.other.get(".querytemplate-cf01409.cc-masonry")!,
      );
      expect(mine.style).not.toHaveProperty("gridTemplateColumns");
      expect(mine.style).not.toHaveProperty("gridAutoRows");
    });
    expect(seen).toBe(1);
  });

  test("masonry ignores the grid builder: no template of its own, no auto rows, only the count, the gaps and the display", () => {
    const result = attrStyleDetailed(
      {
        repeaterMasonry: true,
        containerLayoutDisplay: { lg: "grid" },
        columnsTemplateColumns: { lg: "2" },
        columnsColumnGap: { lg: "10" },
      },
      fl,
      { blockName: "query-template", classID: "c" },
    );
    expect(result.style).toEqual({ position: "relative", display: "grid" });
    expect(result.other.get(".c.cc-masonry")).toEqual({
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      columnGap: "10px",
      rowGap: "10px", // the block type's own default row gap
    });
  });
});

describe("the old section layout", () => {
  test("a section's layout, size and padding go on <classID>-wrapper, the rest stays on the section", () => {
    const result = attrStyleDetailed(
      {
        paddingBottom: { lg: "0px" },
        containerSizeWidth: { lg: "90%", sm: "100%" },
        containerLayoutAlignItems: { lg: "center" },
        containerLayoutFlexDirection: { lg: "column" },
        containerLayoutPosition: { lg: "relative" },
        backgroundColor: { lg: "#fff" },
        marginTop: { lg: "1px" },
      },
      ap,
      { blockName: "section", classID: "s" },
    );
    expect(result.style).toEqual({
      backgroundColor: "#fff",
      marginTop: "1px",
      position: "relative",
    });
    expect(result.wrapper).toEqual({
      alignItems: "center",
      flexDirection: "column",
      width: "90%",
      paddingBottom: "0px",
      "@--sm": { width: "100%" },
    });
  });

  test("another block, or a site without the old layout, has no wrapper", () => {
    expect(
      attrStyleDetailed({ paddingTop: { lg: "1px" } }, ap, { blockName: "div", classID: "d" })
        .wrapper,
    ).toBeUndefined();
    expect(
      attrStyleDetailed({ paddingTop: { lg: "1px" } }, fl, { blockName: "section", classID: "d" })
        .wrapper,
    ).toBeUndefined();
  });

  test("relative styles on an old section are written whole: the wrapper split is for the section's own rule", () => {
    expect(
      attrStyle(
        {
          relativeStyles: [
            {
              id: "W1",
              rules: [{ selectorType: "class", selector: "cc-wrapper", combinator: " " }],
            },
          ],
          containerLayoutAlignItems: { rslgW1: "stretch" },
        },
        ap,
        { blockName: "section", classID: "s" },
      ),
    ).toEqual({ "& .cc-wrapper": { alignItems: "stretch" } });
  });
});

describe("what is not read", () => {
  test("a style attribute no ported family read is listed, the ones that were read are not", () => {
    const result = attrStyleDetailed(
      {
        marginTop: { lg: "1px" },
        menuMainMenuGap: { lg: "30px" },
        menuLayout: { lg: "vertical" },
        paddingTop: { lg: "" },
        interactions: { click: [] },
      },
      fl,
      { classID: "c" },
    );
    expect(result.unsupported).toEqual(["menuMainMenuGap", "menuLayout"]);
  });

  test("an empty or unrelated attribute is not a style, and a block's own data keyed like one is skipped", () => {
    const result = attrStyleDetailed(
      {
        menuMainMenuGap: { lg: "" },
        galleries: [{ images: [1] }],
        metadata: { name: "x" },
        lock: { move: false },
        properties: { a: { value: { lg: "x" } } },
        componentConnectors: { content: { ref: "x" } },
      },
      fl,
      { classID: "c" },
    );
    expect(result.unsupported).toEqual([]);
  });

  test("a palette id the site does not have is reported and the declaration is dropped", () => {
    const result = attrStyleDetailed({ fontTextColor: { lg: "!var=nonesuch!" } }, fl, {
      classID: "c",
    });
    expect(result.unresolvedPalette).toEqual(["nonesuch"]);
    expect(result.style).toEqual({});
  });

  test("an unreadable value is dropped by the reader that reads the real files, not emitted", () => {
    expect(
      fineline({
        backgroundClipPathContent: "polygon(undefined% undefined%,50% 50%)",
        backgroundClipPath: true,
      }),
    ).toEqual({});
    expect(fineline({ columnsControl: false, columnsRowGap: { lg: "" } })).toEqual({});
  });

  test("a clip-path blob is written by an SVG nothing here makes: a note", () => {
    const result = attrStyleDetailed(
      { backgroundClipPath: true, backgroundClipPathBlob: true },
      fl,
      { classID: "c" },
    );
    expect(result.style).toEqual({});
    expect(result.notes[0]).toContain("backgroundClipPath");
  });

  test("the result keeps the CSS it compiled to, for inspection", () => {
    expect(attrStyleDetailed({ marginTop: { lg: "1px" } }, fl, { classID: "c" }).css).toBe(
      ".c{margin-top:1px;}",
    );
  });
});

// ── The oracle ───────────────────────────────────────────────────────────────────────────────────

/** `{a: {b: "1"}}` as `a | b → 1`: declarations by path, so two styles compare as sets. */
function flat(
  style: unknown,
  path: string[] = [],
  out = new Map<string, string>(),
): Map<string, string> {
  if (typeof style !== "object" || style === null) return out;
  for (const [key, value] of Object.entries(style)) {
    if (typeof value === "object" && value !== null) flat(value, [...path, key], out);
    else out.set([...path, key].join(" | "), String(value));
  }
  return out;
}

/** The property a declaration path ends in, put in the family the module ports it as. */
const FAMILIES: [string, RegExp][] = [
  ["spacing", /^(margin|padding|scrollMargin)/],
  [
    "sizing",
    /^(width|height|minWidth|minHeight|maxWidth|maxHeight|aspectRatio|objectFit|objectPosition)$/,
  ],
  [
    "layout",
    /^(display|position|top|left|right|bottom|zIndex|overflow|visibility|flex|alignItems|alignContent|alignSelf|justify|order|gap|rowGap|columnGap|grid|columnCount)/,
  ],
  ["typography", /^(color|font|line|letter|text|word|white|overflowWrap|listStyle)/],
  ["background", /^(background|WebkitBackground)/],
  ["border", /^(border|outline|boxShadow)/],
  ["effects", /^(opacity|filter|backdropFilter|mixBlendMode|transition|animation|textShadow)/],
  ["transform", /^(transform|perspective|backface|WebkitBackface)/],
  ["interaction", /^(cursor|pointerEvents|userSelect)/],
];
const familyOf = (path: string): string => {
  const property = path.split(" | ").at(-1) ?? path;
  return FAMILIES.find(([, re]) => re.test(property))?.[0] ?? "other";
};

interface Tally {
  real: number;
  hit: number;
}

interface SiteResult {
  all: Tally;
  /** Blocks every style attribute of which a family read. */
  scoped: Tally;
  blocks: number;
  exact: number;
  byFamily: Map<string, Tally>;
  /** Per subject: how many of its real declarations the attributes reproduce. */
  bySubject: Map<string, Tally>;
  unsupported: Map<string, number>;
}

/**
 * For every block that HAS a rule in its subject's stylesheets, compile its attributes and compare
 * with the rule the plugin's own generator wrote. Both go through the same reader, so a difference is
 * a difference of meaning. Nothing here can pass by being lenient: a declaration the port does not
 * write is a miss, one it writes wrongly is a miss.
 */
async function oracle(name: SiteName): Promise<SiteResult> {
  const site: LoadedSite = await loadSite(name);
  const result: SiteResult = {
    all: { real: 0, hit: 0 },
    scoped: { real: 0, hit: 0 },
    blocks: 0,
    exact: 0,
    byFamily: new Map(),
    bySubject: new Map(),
    unsupported: new Map(),
  };
  for (const subject of allSubjects(site)) {
    const ctx = await makeCtx(name, subject);
    walkBlocks(subjectBlocks(site, subject), (block) => {
      if (!block.name?.startsWith("cwicly/") || block.name === "cwicly/component") return;
      const classID = block.attrs.classID;
      if (typeof classID !== "string" || classID === "") return;
      const rule = ctx.css.classes.get(classID);
      if (!rule) return;
      const real = flat(rule.style);
      const wrapper = ctx.css.classes.get(`${classID}-wrapper`);
      if (wrapper) for (const [k, v] of flat(wrapper.style)) real.set(`WRAPPER | ${k}`, v);
      // the rules filed beside the tree that name this class as one of two in the first compound
      const named = new RegExp(`^\\.${classID.replaceAll(/[^\w-]/g, "\\$&")}\\.[\\w-]`);
      for (const [selector, style] of ctx.css.other) {
        if (named.test(selector))
          for (const [k, v] of flat(style)) real.set(`OTHER ${selector} | ${k}`, v);
      }
      const ref =
        typeof block.attrs.isComponentChild === "string" ? block.attrs.isComponentChild : "";
      const mine = attrStyleDetailed(block.attrs, ctx, {
        blockName: block.name,
        classID,
        scssCompiler: true,
        variants: (ctx.components.get(ref)?.variants ?? []).map((v) => v.id),
      });
      const got = flat(mine.style);
      if (mine.wrapper) for (const [k, v] of flat(mine.wrapper)) got.set(`WRAPPER | ${k}`, v);
      for (const [selector, style] of mine.other) {
        if (named.test(selector))
          for (const [k, v] of flat(style)) got.set(`OTHER ${selector} | ${k}`, v);
      }
      const subjectKey = JSON.stringify(subject);
      const bySubject = result.bySubject.get(subjectKey) ?? { real: 0, hit: 0 };
      result.bySubject.set(subjectKey, bySubject);
      let exact = got.size === real.size;
      result.blocks++;
      for (const [path, value] of real) {
        const ok = got.get(path) === value;
        if (!ok) exact = false;
        result.all.real++;
        bySubject.real++;
        if (ok) {
          result.all.hit++;
          bySubject.hit++;
        }
        const family = familyOf(path);
        const tally = result.byFamily.get(family) ?? { real: 0, hit: 0 };
        result.byFamily.set(family, tally);
        tally.real++;
        if (ok) tally.hit++;
        if (mine.unsupported.length === 0) {
          result.scoped.real++;
          if (ok) result.scoped.hit++;
        }
      }
      if (exact) result.exact++;
      for (const attribute of mine.unsupported) {
        result.unsupported.set(attribute, (result.unsupported.get(attribute) ?? 0) + 1);
      }
    });
  }
  return result;
}

const pct = (t: Tally): number => (100 * t.hit) / t.real;

describe("against the plugin's own stylesheets (every block with a rule, both sites)", () => {
  const results = new Map<SiteName, SiteResult>();
  beforeAll(async () => {
    for (const name of ["fineline", "ap"] as SiteName[]) results.set(name, await oracle(name));
  });

  test("fineline: 99% of the declarations of 4,152 blocks, 98.6% of the blocks exactly", () => {
    const r = results.get("fineline")!;
    expect(r.blocks).toBe(4152);
    expect(r.all.real).toBe(23953);
    expect(pct(r.all)).toBeGreaterThanOrEqual(99.0);
    expect(pct(r.scoped)).toBeGreaterThanOrEqual(99.2);
    expect((100 * r.exact) / r.blocks).toBeGreaterThanOrEqual(98.5);
  });

  test("ap (cwiclyDefaults off, the old section layout): 99% of the declarations of blocks every attribute of which is read", () => {
    const r = results.get("ap")!;
    expect(r.blocks).toBe(531);
    expect(pct(r.scoped)).toBeGreaterThanOrEqual(98.9);
    expect(pct(r.all)).toBeGreaterThanOrEqual(96.3);
    expect((100 * r.exact) / r.blocks).toBeGreaterThanOrEqual(98.0);
  });

  test("every family of the port reproduces at least 97% of its declarations on fineline", () => {
    const r = results.get("fineline")!;
    for (const family of [
      "layout",
      "spacing",
      "sizing",
      "typography",
      "border",
      "background",
      "effects",
    ]) {
      const tally = r.byFamily.get(family)!;
      expect(tally.real, family).toBeGreaterThan(100);
      expect(pct(tally), family).toBeGreaterThanOrEqual(97);
    }
    expect(r.byFamily.get("layout")!.real).toBeGreaterThan(15000);
  });

  test("the disagreements are concentrated in stale stylesheets and unported families, not spread across the corpus", () => {
    const r = results.get("fineline")!;
    const stale = [...r.bySubject].filter(([, t]) => t.hit < t.real);
    // 8 of the 50-odd subjects with a rule hold every disagreement worth the name
    const missed = [...r.bySubject.values()].reduce((sum, t) => sum + (t.real - t.hit), 0);
    const worst = stale
      .toSorted((a, b) => b[1].real - b[1].hit - (a[1].real - a[1].hit))
      .slice(0, 5)
      .reduce((sum, [, t]) => sum + (t.real - t.hit), 0);
    expect(worst / missed).toBeGreaterThan(0.75);
  });

  test("the unported families that remain are the menu and nav blocks' own, and the grid blocks' auto items", () => {
    const names = new Set<string>();
    for (const r of results.values()) for (const k of r.unsupported.keys()) names.add(k);
    const outsideMenus = [...names].filter((n) => !/^(menu|nav)/.test(n));
    expect(outsideMenus.toSorted()).toEqual([
      "galleryFilterAlign",
      "galleryFilterSpacing",
      "modalAlignItems",
      "modalJustifyContent",
    ]);
  });
});

describe("single real blocks, whole", () => {
  test("a section with only a flex direction: the defaults and the direction, nothing else", async () => {
    const site = await loadSite("fineline");
    const ctx = await makeCtx("fineline", { kind: "post", id: 5246 });
    let seen = 0;
    walkBlocks(subjectBlocks(site, { kind: "post", id: 5246 }), (block) => {
      if (block.attrs.classID !== "section-c93760b") return;
      seen++;
      const mine = attrStyle(block.attrs, ctx, {
        blockName: block.name ?? "",
        classID: "section-c93760b",
      });
      expect(mine).toEqual(ctx.css.classes.get("section-c93760b")!.style);
      expect(mine).toEqual({ position: "relative", display: "flex", flexDirection: "column" });
    });
    expect(seen).toBe(1);
  });

  test("margins, padding, alignment and a reversed row, with a responsive override (div-c45423e)", async () => {
    const site = await loadSite("fineline");
    const ctx = await makeCtx("fineline", { kind: "post", id: 5246 });
    let seen = 0;
    walkBlocks(subjectBlocks(site, { kind: "post", id: 5246 }), (block) => {
      if (block.attrs.classID !== "div-c45423e") return;
      seen++;
      const mine = attrStyle(block.attrs, ctx, {
        blockName: block.name ?? "",
        classID: "div-c45423e",
      });
      expect(flat(mine)).toEqual(flat(ctx.css.classes.get("div-c45423e")!.style));
      expect(mine.flexDirection).toBe("row-reverse");
      expect(mine["@--sm"]).toMatchObject({ marginRight: "auto", paddingLeft: "0px" });
    });
    expect(seen).toBe(1);
  });

  test("an image keeps its default width when only the height and ratio are set", async () => {
    const site = await loadSite("fineline");
    const ctx = await makeCtx("fineline", { kind: "post", id: 5246 });
    walkBlocks(subjectBlocks(site, { kind: "post", id: 5246 }), (block) => {
      if (block.attrs.classID !== "image-cc23dbb") return;
      expect(
        attrStyle(block.attrs, ctx, { blockName: block.name ?? "", classID: "image-cc23dbb" }),
      ).toEqual({ height: "1000px", width: "100%", aspectRatio: "16/9" });
    });
  });
});
