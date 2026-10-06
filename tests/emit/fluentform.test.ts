/**
 * `src/emit/fluentform.ts` over the pilot's real forms (tests/data/fluentform-fineline.json): the
 * markup is the plugin's own, so the structure checked here is what its public stylesheet styles.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  FLUENTFORM_CSS_PATH,
  fluentFormFor,
  fluentFormStylesheet,
  renderFluentForm,
  submitCss,
  turnstileOf,
  TURNSTILE_SCRIPT,
  usedForms,
  type SayForm,
} from "../../src/emit/fluentform.ts";
import { placeholderElement, readPlaceholder } from "../../src/placeholders.ts";
import { createReport } from "../../src/report.ts";
import type { FluentElement, FluentForm } from "../../src/wp/fluentform.ts";
import { pilotForms } from "../helpers/fluentform-db.ts";

const forms = await pilotForms();
const form = (id: number): FluentForm => forms.get(id)!;
const count = (html: string, needle: RegExp): number => [...html.matchAll(needle)].length;

describe("renderFluentForm: the hero's quick estimate form (6)", () => {
  const out = renderFluentForm(form(6));

  test("is wrapped as the plugin wraps a form that picked its own style", () => {
    expect(out.className).toBe("fluentform ff-default fluentform_wrapper_6 ffs_custom_wrap");
    expect(out.html).toStartWith('<form data-form_id="6" id="fluentform_6"');
    expect(out.html).toContain('class="frm-fluent-form fluent_form_6 ff-el-form-top ffs_custom"');
    expect(out.html).toContain(">Quick Estimate</legend>");
    expect(out.css).toContain(".fluentform_wrapper_6.ffs_custom_wrap");
    expect(out.unsupported).toEqual([]);
  });

  test("draws the visible parts of the name element, side by side, with their labels", () => {
    expect(out.html).toContain('name="names_1[first_name]"');
    expect(out.html).toContain('name="names_1[last_name]"');
    // the middle name is switched off in the editor
    expect(out.html).not.toContain("middle_name");
    expect(out.html).toContain('placeholder="Enter Your First Name"');
    expect(out.html).toContain(
      `<label for='ff_6_names_1_first_name_' id='label_ff_6_names_1_first_name_' aria-label="First Name">First Name</label>`,
    );
  });

  test("keeps the two-column containers and their widths", () => {
    expect(count(out.html, /ff_columns_total_2/g)).toBe(2);
    expect(count(out.html, /style='flex-basis: 50%;'/g)).toBe(4);
    expect(out.html).toContain("ff-t-column-1");
    expect(out.html).toContain("ff-t-column-2");
  });

  test("marks required fields, hides a hidden label with the placement class, and types the controls", () => {
    expect(out.html).toContain(
      "<div class=\"ff-el-input--label ff-el-is-required asterisk-right\"><label for='ff_6_phone'",
    );
    expect(out.html).toContain('type="tel" name="phone"');
    expect(out.html).toContain("ff-el-form-control ff-el-phone");
    expect(out.html).toContain('type="email" name="email"');
    expect(out.html).toContain('type="number" name="numeric_field"');
    expect(out.html).toContain("ff-el-group ff-el-form-hide_label");
    expect(out.html).toContain("aria-required=true");
  });

  test("draws the select with its placeholder as WordPress prints it (wptexturize) and its options", () => {
    expect(out.html).toContain('<option value="">– Select Job Type –</option>');
    for (const option of ["Interior", "Exterior", "Cabin Staining", "Roof", "Other"]) {
      expect(out.html).toContain(`<option value="${option}">${option}</option>`);
    }
  });

  test("ends with the submit button, aligned as the form says", () => {
    expect(out.html).toContain("ff-el-group ff-text-center ff_submit_btn_wrapper");
    expect(out.html).toContain(
      '<button type="submit" class="ff-btn ff-btn-submit ff-btn-md ff_btn_style" aria-label="Get My Free Estimate">Get My Free Estimate</button>',
    );
    expect(out.html).toEndWith("</fieldset></form>");
  });
});

describe("renderFluentForm: the quote form (3)", () => {
  const out = renderFluentForm(form(3));

  test("draws an address as rows of two parts and keeps the state's default", () => {
    expect(out.html).toContain('data-type="address-element" data-name="address_1"');
    expect(out.html).toContain('name="address_1[address_line_1]"');
    expect(out.html).toContain('name="address_1[zip]"');
    expect(out.html).toContain('name="address_1[state]" value="PA"');
    // line 1 + line 2, city + state, zip: three rows inside each of the two addresses
    expect(count(out.html, /<div class='ff-t-container'>/g)).toBeGreaterThanOrEqual(6);
    // the billing address waits for its checkbox, so the plugin's stylesheet hides it
    expect(out.html).toMatch(
      /class="ff-name-address-wrapper fluent-address has-conditions" data-type="address-element" data-name="address_2"/,
    );
  });

  test("the parts of the name take the name's label placement when they name none", () => {
    expect(out.html).toContain(
      `<div class='ff-el-group ff-el-form-top'><div class="ff-el-input--label asterisk-right"><label for='ff_3_names_first_name_'`,
    );
    // a plain element has no placement class of its own
    expect(out.html).toContain(
      `<div class='ff-el-group'><div class="ff-el-input--label asterisk-right"><label for='ff_3_email'`,
    );
  });

  test("draws a checkbox group with array names, a radio group with a shared name, and the file field", () => {
    expect(out.html).toContain('name="checkbox[]"');
    expect(out.html).toContain("ff-el-form-check-input ff-el-form-check-checkbox");
    expect(count(out.html, /type="radio" name="input_radio"/g)).toBe(2);
    expect(out.html).toContain("ff_file_upload_holder");
    expect(out.html).toContain('type="file" name="image-upload"');
    expect(out.html).toContain('accept="image/*"');
    expect(out.html).toContain("<textarea");
  });

  test("keeps a custom HTML element's markup and hides it when it has conditions", () => {
    expect(out.html).toContain("ff-custom_html has-conditions");
    expect(out.html).toContain("You have successfully opted-in to receive SMS notifications");
  });

  test("a style a block names replaces the form's own, in the wrapper and the form", () => {
    const classic = renderFluentForm(form(1), "ffs_classic");
    expect(classic.className).toBe("fluentform ff-default fluentform_wrapper_1 ffs_classic_wrap");
    expect(classic.html).toContain("fluent_form_1 ff-el-form-top ffs_classic");
    expect(classic.css).toContain(".fluentform_wrapper_1.ffs_classic_wrap");
    // the form that never chose one is the plugin's default, which has no rules of its own
    const plain = renderFluentForm(form(5));
    expect(plain.className).toBe("fluentform ff-default fluentform_wrapper_5 ffs_default_wrap");
    // ...but its submit button's colours are printed all the same
    expect(plain.css).toBe(
      "form.fluent_form_5 .ff-btn-submit:not(.ff_btn_no_style) { background-color: #409EFF; color: #ffffff; }",
    );
  });
});

describe("the submit button's own rules", () => {
  const button = (settings: Record<string, unknown>): FluentElement => ({
    element: "button",
    attributes: { type: "submit", class: "" },
    settings,
    editor_options: {},
  });
  const css = (settings: Record<string, unknown> | undefined) =>
    submitCss({ id: 6 }, settings === undefined ? undefined : button(settings));

  test("the default look prints its colours, with the plugin's blue as its variable", () => {
    // the live page prints exactly this into its footer for the hero's form (#1a7efb is the plugin's own blue)
    expect(renderFluentForm(form(6)).css).toContain(
      "form.fluent_form_6 .ff-btn-submit:not(.ff_btn_no_style) { background-color: var(--fluentform-primary); color: #ffffff; }",
    );
    expect(css({ button_style: "default", background_color: "#abcdef", color: "#000" })).toBe(
      "form.fluent_form_6 .ff-btn-submit:not(.ff_btn_no_style) { background-color: #abcdef; color: #000; }",
    );
  });

  test("a button with no look, or no_style, prints none of the default's", () => {
    expect(css({ button_style: "no_style", background_color: "#abcdef" })).toBe("");
    expect(css(undefined)).toBe("");
  });

  test("a custom button prints its normal and hover styles, dashed, skipping the empty ones", () => {
    const custom = css({
      button_style: "",
      // "0" is a value; an empty string, a number 0, false and null are not
      normal_styles: {
        backgroundColor: "#111",
        borderRadius: "4",
        minWidth: "",
        opacity: "0",
        top: 0,
        left: false,
        right: null,
      },
      hover_styles: { color: "#fff" },
    });
    expect(custom).toBe(
      "form.fluent_form_6 .ff-btn-submit.wpf_has_custom_css { background-color:#111;border-radius:4px;opacity:0; }" +
        "form.fluent_form_6 .ff-btn-submit.wpf_has_custom_css:hover { color:#fff; }",
    );
    expect(css({ button_style: "" })).toBe("");
    // a button that names no look at all is the custom kind too, and carries the old primary class
    const html = renderFluentForm({
      id: 9,
      title: "t",
      fields: [],
      submitButton: button({ normal_styles: { color: "red" } }),
      styles: new Map(),
      style: "",
      layout: {},
    });
    expect(html.html).toContain(
      'class="ff-btn ff-btn-submit ff-btn-primary ff-btn-md ff_btn_style wpf_has_custom_css"',
    );
    expect(html.css).toContain(".wpf_has_custom_css { color:red; }");
  });

  test("a no_style button says so in its class", () => {
    const html = renderFluentForm({
      id: 9,
      title: "t",
      fields: [],
      submitButton: button({ button_style: "no_style" }),
      styles: new Map(),
      style: "",
      layout: {},
    });
    expect(html.html).toContain('class="ff-btn ff-btn-submit ff-btn-md ff_btn_no_style"');
    expect(html.css).toBe("");
  });
});

describe("the bot check", () => {
  const options = (entries: Record<string, string>) => new Map(Object.entries(entries));
  const on = {
    cfturnstile_fluent: "on",
    cfturnstile_key: "0xKEY",
    cfturnstile_theme: "light",
    cfturnstile_size: "normal",
    cfturnstile_appearance: "always",
    cfturnstile_language: "auto",
  };

  test("the plugin's settings say whether a form carries the widget and how it looks", () => {
    expect(turnstileOf(options(on))).toEqual({
      siteKey: "0xKEY",
      theme: "light",
      size: "normal",
      appearance: "always",
      language: "auto",
    });
    // defaults of the plugin for what the site did not set
    expect(turnstileOf(options({ cfturnstile_fluent: "on", cfturnstile_key: " 0xK " }))).toEqual({
      siteKey: "0xK",
      theme: "auto",
      size: "normal",
      appearance: "always",
      language: "auto",
    });
    // off for Fluent Forms, disabled, or with no key
    expect(turnstileOf(options({ ...on, cfturnstile_fluent: "" }))).toBeUndefined();
    expect(turnstileOf(options({ ...on, cfturnstile_fluent_disable: "on" }))).toBeUndefined();
    expect(turnstileOf(options({ ...on, cfturnstile_key: "" }))).toBeUndefined();
    expect(turnstileOf(undefined)).toBeUndefined();
  });

  test("a form that carries it has the element the Cloudflare script fills, right after the submit button", () => {
    const out = renderFluentForm(form(6), undefined, turnstileOf(options(on)));
    expect(out.html).toContain(
      '</button></div><div class="cf-turnstile" data-sitekey="0xKEY" data-theme="light"',
    );
    expect(out.html).toContain(
      'data-action="fluent-form-6" data-appearance="always"></div><br class="cf-turnstile-br"></fieldset>',
    );
    expect(renderFluentForm(form(6)).html).not.toContain("cf-turnstile");
  });

  test("drawing one with the site's options records that the page needs the script, and the report says why", () => {
    const site = { forms, model: { options: options(on) } };
    const report = createReport();
    const element = fluentFormFor(
      site,
      readPlaceholder(
        placeholderElement("shortcode", {
          "data-shortcode": "fluentform",
          "data-attributes": '{"id":"6"}',
        }),
      )!,
      (entry) => report.add({ ...entry, where: "test" }),
    )!;
    expect(String(element.innerHTML)).toContain("cf-turnstile");
    expect(usedForms(site).map((u) => u.turnstile)).toEqual([true]);
    expect(report.entries()[0]!.message).toContain("Cloudflare's own widget");
    expect(TURNSTILE_SCRIPT).toBe("https://challenges.cloudflare.com/turnstile/v0/api.js");
  });
});

describe("renderFluentForm: edge cases", () => {
  const base = (fields: FluentElement[]): FluentForm => ({
    id: 77,
    title: "A <b>form</b>",
    fields,
    submitButton: undefined,
    styles: new Map(),
    style: "",
    layout: {},
  });

  test("escapes what a person typed, and says what it cannot draw", () => {
    const out = renderFluentForm(
      base([
        {
          element: "input_text",
          attributes: { name: 'a"b', placeholder: "<x>" },
          settings: { label: "L & M", validation_rules: { required: { value: true } } },
        },
        { element: "ratings", settings: { label: "Rate us" } },
        { element: "input_hidden", attributes: { name: "ref", value: "q&a" } },
      ]),
    );
    expect(out.html).toContain("A &lt;b&gt;form&lt;/b&gt;");
    expect(out.html).toContain('name="a&quot;b"');
    expect(out.html).toContain('placeholder="&lt;x&gt;"');
    expect(out.html).toContain(">L &amp; M</label>");
    expect(out.html).toContain('<input type="hidden" name="ref" value="q&amp;a">');
    expect(out.unsupported).toEqual([{ element: "ratings", label: "Rate us" }]);
    // no style selected: the plugin's default wrapper, no styler rules
    expect(out.className).toBe("fluentform ff-default fluentform_wrapper_77");
    expect(out.html).toContain("Submit</button>");
  });

  test("an element the form hides behind conditions gets the class that hides it", () => {
    const out = renderFluentForm(
      base([
        {
          element: "input_text",
          attributes: { name: "x" },
          settings: { label: "X", conditional_logics: { status: true } },
        },
      ]),
    );
    expect(out.html).toContain("ff-el-group has-conditions");
  });
});

describe("fluentFormFor", () => {
  const say =
    (sink: ReturnType<typeof createReport>): SayForm =>
    (entry) =>
      sink.add({ ...entry, where: "test" });

  const shortcode = (attrs: Record<string, string>) =>
    readPlaceholder(
      placeholderElement("shortcode", {
        "data-shortcode": "fluentform",
        "data-attributes": JSON.stringify(attrs),
        "data-source": '[fluentform id="6"]',
      }),
    )!;
  const block = (blockAttrs: Record<string, unknown>) =>
    readPlaceholder(
      placeholderElement(
        "block",
        {},
        { block: { name: "fluentfom/guten-block", attrs: blockAttrs } },
      ),
    )!;

  test("turns the shortcode and the block into the form's element and says it cannot be submitted", () => {
    const site = { forms };
    const report = createReport();
    const fromShortcode = fluentFormFor(site, shortcode({ id: "6" }), say(report))!;
    expect(fromShortcode.className).toBe(
      "fluentform ff-default fluentform_wrapper_6 ffs_custom_wrap",
    );
    expect(fromShortcode.attributes).toEqual({ "data-wp2jx": "fluentform:6" });
    expect(String(fromShortcode.innerHTML)).toStartWith('<form data-form_id="6"');
    const fromBlock = fluentFormFor(
      site,
      block({ formId: "1", themeStyle: "ffs_classic" }),
      say(report),
    )!;
    expect(fromBlock.className).toContain("ffs_classic_wrap");
    expect(report.entries().map((e) => e.code)).toEqual([
      "form.not-submittable",
      "form.not-submittable",
    ]);
    // the assembler learns which styles were drawn, once each
    expect(usedForms(site).map((u) => u.id)).toEqual([6, 1]);
    fluentFormFor(site, shortcode({ id: "6" }), say(report));
    expect(usedForms(site)).toHaveLength(2);
  });

  test("a form the database does not hold, or a placeholder that is not a form, is left to the caller", () => {
    const report = createReport();
    expect(fluentFormFor({ forms }, shortcode({ id: "999" }), say(report))).toBeUndefined();
    expect(report.entries().map((e) => e.code)).toEqual(["form.missing"]);
    expect(fluentFormFor({}, shortcode({ id: "6" }), say(createReport()))).toBeUndefined();
    expect(fluentFormFor({ forms }, shortcode({}), say(createReport()))).toBeUndefined();
    expect(fluentFormFor({ forms }, block({ formId: "x" }), say(createReport()))).toBeUndefined();
    const other = readPlaceholder(
      placeholderElement("shortcode", {
        "data-shortcode": "gallery",
        "data-attributes": '{"id":"6"}',
      }),
    )!;
    expect(fluentFormFor({ forms }, other, say(createReport()))).toBeUndefined();
    const unreadable = readPlaceholder(
      placeholderElement("shortcode", {
        "data-shortcode": "fluentform",
        "data-attributes": "{oops",
      }),
    )!;
    expect(fluentFormFor({ forms }, unreadable, say(createReport()))).toBeUndefined();
  });

  test("a dollar-brace in a form's own HTML is never evaluated", () => {
    const site = {
      forms: new Map([
        [
          9,
          {
            id: 9,
            title: "T",
            fields: [{ element: "custom_html", settings: { html_codes: "<p>${state.x}</p>" } }],
            submitButton: undefined,
            styles: new Map(),
            style: "ffs_default",
            layout: {},
          } as FluentForm,
        ],
      ]),
    };
    const element = fluentFormFor(site, shortcode({ id: "9" }), say(createReport()))!;
    expect(String(element.innerHTML)).not.toContain("${");
    expect(String(element.innerHTML)).toContain("&#36;{state.x}");
  });

  test("reports an element it cannot draw", () => {
    const site = {
      forms: new Map([
        [
          9,
          {
            id: 9,
            title: "T",
            fields: [{ element: "ratings", settings: { label: "Rate" } }],
            submitButton: undefined,
            styles: new Map(),
            style: "",
            layout: {},
          } as FluentForm,
        ],
      ]),
    };
    const report = createReport();
    fluentFormFor(site, shortcode({ id: "9" }), say(report));
    expect(report.entries().map((e) => e.code)).toEqual([
      "form.not-submittable",
      "form.element-unsupported",
    ]);
  });
});

describe("fluentFormStylesheet", () => {
  const root = resolve(import.meta.dir, "../..");
  const css = join("wp-content", "plugins", "fluentform", "assets", "css");

  test("is the plugin's two public stylesheets and the styler rules of the forms drawn", async () => {
    mkdirSync(join(root, ".dev/tmp"), { recursive: true });
    const dir = mkdtempSync(join(root, ".dev/tmp/ffcss-"));
    try {
      mkdirSync(join(dir, css), { recursive: true });
      writeFileSync(join(dir, css, "fluent-forms-public.css"), ".ff-el-group{margin:0}");
      writeFileSync(join(dir, css, "fluentform-public-default.css"), ".ff-default{color:red}");
      const report = createReport();
      const sheet = await fluentFormStylesheet(
        [
          { id: 6, css: ".fluentform_wrapper_6{x:y}" },
          { id: 5, css: "" },
        ],
        dir,
        report,
      );
      expect(sheet?.path).toBe(FLUENTFORM_CSS_PATH);
      expect(sheet?.content).toContain(".ff-el-group{margin:0}");
      expect(sheet?.content).toContain(".ff-default{color:red}");
      expect(sheet?.content).toContain(".fluentform_wrapper_6{x:y}");
      expect(sheet!.content.indexOf(".ff-el-group")).toBeLessThan(
        sheet!.content.indexOf(".ff-default"),
      );
      expect(sheet!.content.indexOf(".ff-default")).toBeLessThan(
        sheet!.content.indexOf("wrapper_6"),
      );
      expect(report.entries()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("says which file it could not find, and writes nothing for a site that drew no form", async () => {
    const report = createReport();
    const sheet = await fluentFormStylesheet([{ id: 6, css: ".a{}" }], undefined, report);
    expect(sheet?.content).toContain(".a{}");
    expect(report.entries().map((e) => e.code)).toEqual(["form.css-missing", "form.css-missing"]);
    expect(await fluentFormStylesheet([], "/nowhere", createReport())).toBeUndefined();
  });
});
