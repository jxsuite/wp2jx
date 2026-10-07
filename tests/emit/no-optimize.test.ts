/**
 * Pictures the image optimiser cannot decode. The bytes are the signature of the real file anabaptist
 * perspectives serves as `description_20210223_220803509_iOS.heic.jpg` (an `ftyp heic` HEIF container
 * with `image/jpeg` on it); the directive line is the one the converter wrote for it.
 */
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { transpileJxMarkdown } from "@jxsuite/parser/transpile";
import { markNoOptimize, undecodableImage } from "../../src/emit/no-optimize.ts";
import { buildJxProject, cleanupJxProjects } from "../helpers/jx-build.ts";

setDefaultTimeout(120_000);
afterAll(cleanupJxProjects);

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const HEIC = Uint8Array.from([0, 0, 0, 24, ...ascii("ftypheic"), 0, 0, 0, 0, ...ascii("mif1heic")]);
const PNG = Uint8Array.from([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const BMP = Uint8Array.from([0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 54, 0, 0, 0]);
const AVIF = Uint8Array.from([0, 0, 0, 24, ...ascii("ftypavif"), 0, 0, 0, 0, ...ascii("mif1avif")]);

const SRC = "/media/2021/04/description_20210223_220803509_iOS.heic.jpg";
const DIRECTIVE = `::img{className="wp-image-1470" src="${SRC}" alt data-id="1470" data-link="https://anabaptistperspectives.org/?attachment_id=1470"}`;

describe("undecodableImage", () => {
  test("a HEIC picture is named as one; the formats Sharp reads are not", () => {
    expect(undecodableImage(HEIC)).toMatch(/HEIC/);
    expect(undecodableImage(PNG)).toBeUndefined();
    expect(undecodableImage(AVIF)).toBeUndefined();
  });

  test("a format with no loader is said, and what is not a picture is the download's business", () => {
    expect(undecodableImage(BMP)).toMatch(/image\/bmp/);
    expect(undecodableImage(Uint8Array.from(ascii("%PDF-1.4")))).toBeUndefined();
    expect(undecodableImage(new Uint8Array())).toBeUndefined();
    expect(undecodableImage(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
  });
});

describe("markNoOptimize", () => {
  test("a Markdown directive, an inline directive and an HTML tag carry the attribute; the other pictures do not", () => {
    const other = `::img{src="/media/2021/04/fine.jpg" alt="x"}`;
    const files = new Map<string, string | Uint8Array>([
      [
        "content/u/a.md",
        `---\ntitle: a\n---\n\n${DIRECTIVE}\n\n${other}\n\nText :img{src="${SRC}"} and <img src="${SRC}" alt="">.\n`,
      ],
    ]);
    const result = markNoOptimize(files, new Set([SRC]));
    expect(result.changed).toEqual([{ path: "content/u/a.md", count: 3 }]);
    const text = files.get("content/u/a.md") as string;
    expect(text).toContain(`${DIRECTIVE.slice(0, -1)} data-no-optimize}`);
    expect(text).toContain(`${other}\n`);
    expect(text).toContain(`:img{src="${SRC}" data-no-optimize}`);
    expect(text).toContain(`<img src="${SRC}" alt="" data-no-optimize>`);
    // Once is enough: a second pass changes nothing.
    expect(markNoOptimize(files, new Set([SRC])).changed).toEqual([]);
  });

  test("the reader takes the directive's bare attribute as an attribute of the image", () => {
    const files = new Map<string, string | Uint8Array>([["content/u/a.md", `${DIRECTIVE}\n`]]);
    markNoOptimize(files, new Set([SRC]));
    const doc = JSON.stringify(transpileJxMarkdown(files.get("content/u/a.md") as string));
    expect(doc).toContain('"data-no-optimize"');
    expect(doc).toContain(SRC);
  });

  test("a JSON document's image node and an innerHTML tag are marked, wherever the node sits", () => {
    const files = new Map<string, string | Uint8Array>([
      [
        "pages/a.json",
        JSON.stringify({
          children: [
            { tagName: "img", attributes: { src: SRC, alt: "" } },
            { tagName: "div", children: [{ tagName: "img", src: SRC }] },
            { tagName: "p", innerHTML: `<img src="${SRC}?x=1" alt="">` },
            { tagName: "img", attributes: { src: "/media/other.jpg" } },
          ],
        }),
      ],
      ["public/x.bin", new Uint8Array([1])],
      // Bytes under a name that says text are bytes: never read as text.
      ["pages/blob.json", new Uint8Array([123, 125])],
      ["content/blob.md", new Uint8Array([58, 58, 105, 109, 103])],
      ["pages/bad.json", "{"],
    ]);
    const result = markNoOptimize(files, new Set([SRC]));
    expect(result.changed).toEqual([{ path: "pages/a.json", count: 3 }]);
    const doc = JSON.parse(files.get("pages/a.json") as string);
    expect(doc.children[0].attributes).toEqual({ src: SRC, alt: "", "data-no-optimize": "" });
    expect(doc.children[1].children[0].attributes).toEqual({ "data-no-optimize": "" });
    expect(doc.children[2].innerHTML).toBe(`<img src="${SRC}?x=1" alt="" data-no-optimize>`);
    expect(doc.children[3].attributes).toEqual({ src: "/media/other.jpg" });
  });

  test("an address with escapes is matched on what it names; nothing to mark touches nothing", () => {
    const files = new Map<string, string | Uint8Array>([
      ["content/u/a.md", `::img{src="/media/a%20b.heic.jpg"}\n`],
    ]);
    expect(markNoOptimize(files, new Set()).changed).toEqual([]);
    expect(markNoOptimize(files, new Set(["/media/a b.heic.jpg"])).changed).toHaveLength(1);
  });
});

describe("the build", () => {
  const page = (attributes: Record<string, string>) => ({
    "pages/index.json": {
      children: [{ tagName: "img", attributes: { src: "/media/x.heic.jpg", ...attributes } }],
    },
    "public/media/x.heic.jpg": HEIC,
  });

  test("a HEIC under a .jpg name stops the build; with the attribute the page builds and keeps the file", async () => {
    const broken = await buildJxProject(page({}), { name: "heic-broken", allowFailure: true });
    expect(broken.code).not.toBe(0);
    const files = new Map<string, string | Uint8Array>(
      Object.entries(page({})).map(([k, v]) => [
        k,
        v instanceof Uint8Array ? v : JSON.stringify(v),
      ]),
    );
    markNoOptimize(files, new Set(["/media/x.heic.jpg"]));
    const marked = JSON.parse(files.get("pages/index.json") as string);
    const built = await buildJxProject(
      { "pages/index.json": marked, "public/media/x.heic.jpg": HEIC },
      { name: "heic-marked" },
    );
    expect(built.html("/")).toContain("/media/x.heic.jpg");
  });
});
