/**
 * Fluent Forms, drawn as static markup.
 *
 * A Fluent Forms form is rendered by PHP on every request and driven by the plugin's JavaScript; a
 * migrated site has neither, so a form can be drawn but not submitted. What a visitor sees is still
 * worth keeping: the form's height decides where everything below it sits, and on finelinepainting
 * the "Get Your Free Estimate" form is inside the hero of every service page. The markup here is the
 * plugin's own (`ff-el-group`, `ff-t-container`, `ff-el-form-control`…), so the plugin's public
 * stylesheet, shipped by the project assembler, styles it exactly as it does on the live site; the
 * form styler's generated rules (`FluentForm.css`) are shipped beside it.
 *
 * What is not carried, and said so in the report: submission (`form.not-submittable`), the plugin's
 * bot protection widget (Cloudflare Turnstile, drawn by a script), conditional logic (an element with
 * conditions is hidden, as the plugin's stylesheet hides it until a script reveals it), elements this
 * module does not draw (`form.element-unsupported`) and a form the database does not hold
 * (`form.missing`).
 *
 * Report codes: `form.not-submittable` (warn, once per form and page), `form.element-unsupported`
 * (warn), `form.missing` (warn).
 */
import { escapeHtml, texturize } from "../cwicly/tokens.ts";
import { escapeTemplate } from "../jx-util.ts";
import type { Placeholder } from "../placeholders.ts";
import type { JxElement } from "../types.ts";
import type { FluentElement, FluentForm } from "../wp/fluentform.ts";

const text = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `settings` of an element as a record (the plugin stores `[]` for none). */
const settingsOf = (e: FluentElement): Record<string, unknown> =>
  isRecord(e.settings) ? e.settings : {};
const attrsOf = (e: FluentElement): Record<string, unknown> =>
  isRecord(e.attributes) ? e.attributes : {};

/** Text for an attribute value or an element's content: the quotes too, because every attribute here is quoted. */
const escQuoted = (s: string): string =>
  escapeHtml(s).replaceAll('"', "&quot;").replaceAll("'", "&#039;");

const esc = (v: unknown): string => escQuoted(text(v));

/** A string the browser shows (a placeholder, an option): WordPress prints these through wptexturize. */
const shown = (v: unknown): string => escQuoted(texturize(text(v)));

/** The script that draws every `cf-turnstile` element of a page (implicit rendering). */
export const TURNSTILE_SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js";

/** The Simple Cloudflare Turnstile plugin's settings that decide what its widget looks like. */
export interface TurnstileOptions {
  siteKey: string;
  theme: string;
  size: string;
  appearance: string;
  language: string;
}

/** The widget the plugin adds to its forms, from its options (`cfturnstile_*`), or undefined when it is off here. */
export function turnstileOf(
  options: ReadonlyMap<string, string> | undefined,
): TurnstileOptions | undefined {
  if (options === undefined) return undefined;
  const get = (name: string): string => options.get(name) ?? "";
  if (get("cfturnstile_fluent") !== "on" || get("cfturnstile_fluent_disable") !== "")
    return undefined;
  const siteKey = get("cfturnstile_key").trim();
  if (siteKey === "") return undefined;
  return {
    siteKey,
    theme: get("cfturnstile_theme") || "auto",
    size: get("cfturnstile_size") || "normal",
    appearance: get("cfturnstile_appearance") || "always",
    language: get("cfturnstile_language") || "auto",
  };
}

/** What the plugin prints under the submit button: the element the Cloudflare script fills, and the line break after it. */
function turnstileMarkup(form: FluentForm, t: TurnstileOptions): string {
  return `<div class="cf-turnstile" data-sitekey="${esc(t.siteKey)}" data-theme="${esc(t.theme)}" data-language="${esc(t.language)}" data-size="${esc(t.size)}" data-retry="auto" data-retry-interval="1000" data-refresh-expired="auto" data-refresh-timeout="auto" data-action="fluent-form-${form.id}" data-appearance="${esc(t.appearance)}"></div><br class="cf-turnstile-br">`;
}

export interface RenderedForm {
  /** The classes of the wrapper `div` the plugin prints (`fluentform ff-default fluentform_wrapper_6 ffs_custom_wrap`). */
  className: string;
  /** What is inside the wrapper: the `<form>`. */
  html: string;
  /** What the form needs that the page cannot give it, one entry per kind (for the report). */
  unsupported: { element: string; label: string }[];
  /** The styler stylesheet of the style the form is drawn in, "" for none. */
  css: string;
}

interface Ctx {
  form: FluentForm;
  unsupported: { element: string; label: string }[];
  asterisk: string;
}

const required = (e: FluentElement): boolean => {
  const rules = settingsOf(e).validation_rules;
  if (!isRecord(rules)) return false;
  const rule = rules.required;
  return isRecord(rule) && rule.value === true;
};

const hasConditions = (e: FluentElement): boolean => {
  const logic = settingsOf(e).conditional_logics;
  return isRecord(logic) && logic.status === true;
};

/** The class of an element's label placement; `inherit` is the element a part of it sits in (a name's parts take the name's own). */
const placement = (e: FluentElement, inherit?: FluentElement): string => {
  const p =
    text(settingsOf(e).label_placement) ||
    (inherit === undefined ? "" : text(settingsOf(inherit).label_placement));
  return p === "" ? "" : `ff-el-form-${p}`;
};

/** The label block: omitted for an element without a label. */
function label(
  ctx: Ctx,
  e: FluentElement,
  id: string,
  opts: { labelFor?: boolean; text?: string } = {},
): string {
  const label = opts.text ?? text(settingsOf(e).label);
  if (label === "") return "";
  const classes = ["ff-el-input--label"];
  if (required(e)) classes.push("ff-el-is-required");
  if (ctx.asterisk !== "") classes.push(ctx.asterisk);
  const forAttr = opts.labelFor === false ? "" : ` for='${esc(id)}' id='label_${esc(id)}'`;
  return `<div class="${classes.join(" ")}"><label${forAttr} aria-label="${esc(label)}">${shown(label)}</label></div>`;
}

function group(e: FluentElement, inner: string, extra = ""): string {
  const classes = ["ff-el-group", placement(e), extra].filter((c) => c !== "");
  return `<div class='${classes.join(" ")}'>${inner}</div>`;
}

/** The one-line inputs: `input_text`, `input_email`, `input_number`, `phone`, `input_url`… */
function inputControl(ctx: Ctx, e: FluentElement, nameOverride?: string): string {
  const a = attrsOf(e);
  const name = nameOverride ?? text(a.name);
  const id = `ff_${ctx.form.id}_${name.replace(/\[/g, "_").replace(/\]/g, "_")}`;
  const type =
    e.element === "phone"
      ? "tel"
      : e.element === "input_number"
        ? "number"
        : text(a.type) || "text";
  const classes = ["ff-el-form-control"];
  if (e.element === "phone") classes.push("ff-el-phone");
  const placeholder = text(a.placeholder);
  const value = text(a.value);
  const parts = [`type="${esc(type)}"`, `name="${esc(name)}"`];
  if (value !== "") parts.push(`value="${esc(value)}"`);
  parts.push(`id="${esc(id)}"`, `class="${classes.join(" ")}"`);
  if (placeholder !== "") parts.push(`placeholder="${shown(placeholder)}"`);
  if (e.element === "input_number") parts.push('step="any"');
  parts.push('aria-invalid="false"', `aria-required=${required(e) ? "true" : "false"}`);
  return `<input ${parts.join(" ")}>`;
}

function labelled(ctx: Ctx, e: FluentElement, control: string, id: string): string {
  return group(e, `${label(ctx, e, id)}<div class='ff-el-input--content'>${control}</div>`);
}

function options(e: FluentElement): { label: string; value: string }[] {
  const raw = settingsOf(e).advanced_options;
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((o) => ({ label: text(o.label), value: text(o.value) }));
}

function select(ctx: Ctx, e: FluentElement): string {
  const a = attrsOf(e);
  const name = text(a.name);
  const id = `ff_${ctx.form.id}_${name}`;
  const placeholder = text(settingsOf(e).placeholder);
  const opts = options(e)
    .map((o) => `<option value="${esc(o.value)}">${shown(o.label)}</option>`)
    .join("");
  const first = placeholder === "" ? "" : `<option value="">${shown(placeholder)}</option>`;
  const control = `<select name="${esc(name)}" id="${esc(id)}" class="ff-el-form-control" data-name="${esc(name)}" aria-invalid="false" aria-required="${required(e) ? "true" : "false"}">${first}${opts}</select>`;
  return labelled(ctx, e, control, id);
}

/** A radio or checkbox group: one `ff-el-form-check` per option. */
function checks(ctx: Ctx, e: FluentElement): string {
  const a = attrsOf(e);
  const kind = e.element === "input_radio" ? "radio" : "checkbox";
  const name = text(a.name);
  const fieldName = kind === "checkbox" ? `${name}[]` : name;
  const boxes = options(e)
    .map((o, i) => {
      const id = `${kind === "radio" ? "input_radio" : name}_${ctx.form.id}_${i}`;
      return `<div class='ff-el-form-check ff-el-form-check-'><label class='ff-el-form-check-label' for='${esc(id)}'><input type="${kind}" name="${esc(fieldName)}" data-name="${esc(name)}" class="ff-el-form-check-input ff-el-form-check-${kind}" value="${esc(o.value)}" id='${esc(id)}' aria-label='${esc(o.label)}' aria-invalid='false' aria-required=${required(e) ? "true" : "false"}> <span>${shown(o.label)}</span></label></div>`;
    })
    .join("");
  return group(
    e,
    `${label(ctx, e, `${name}`, { labelFor: false })}<div class='ff-el-input--content'>${boxes}</div>`,
  );
}

function textarea(ctx: Ctx, e: FluentElement): string {
  const a = attrsOf(e);
  const name = text(a.name);
  const id = `ff_${ctx.form.id}_${name}`;
  const rows = text(a.rows) || "3";
  const cols = text(a.cols) || "2";
  const placeholder = text(a.placeholder);
  const control = `<textarea aria-required="${required(e) ? "true" : "false"}" aria-labelledby="label_${esc(id)}" name="${esc(name)}" id="${esc(id)}" class="ff-el-form-control"${placeholder === "" ? "" : ` placeholder="${shown(placeholder)}"`} rows="${esc(rows)}" cols="${esc(cols)}" data-name="${esc(name)}"></textarea>`;
  return labelled(ctx, e, control, id);
}

function upload(ctx: Ctx, e: FluentElement): string {
  const a = attrsOf(e);
  const name = text(a.name);
  const id = `ff_${ctx.form.id}_${name}_1`;
  const button = text(settingsOf(e).btn_text) || "Choose File";
  const control = `<label for='${esc(id)}' class='ff_file_upload_holder'><span class='ff_upload_btn ff-btn' tabindex='0'>${shown(button)}</span> <input type="file" name="${esc(name)}" id="${esc(id)}" class="ff-el-form-control ff-screen-reader-element"${e.element === "input_image" ? ' accept="image/*"' : ""} data-name="${esc(name)}" aria-invalid='false' aria-required=${required(e) ? "true" : "false"}></label>`;
  return group(e, `${label(ctx, e, id)}<div class='ff-el-input--content'>${control}</div>`);
}

/** Whether a part of a composite element is shown (`visible` is absent on the always-shown ones). */
const visible = (part: FluentElement): boolean => settingsOf(part).visible !== false;

/** A cell of a row of fields. */
const cell = (inner: string, extra = ""): string =>
  `<div class='ff-t-cell${extra === "" ? "" : ` ${extra}`}'>${inner}</div>`;

function partControl(ctx: Ctx, part: FluentElement, name: string, parent: string): string {
  const id = `ff_${ctx.form.id}_${parent}_${name}_`;
  const control = partInput(part, `${parent}[${name}]`, id, name);
  return `<div class='ff-el-group'>${label(ctx, part, id)}<div class='ff-el-input--content'>${control}</div></div>`;
}

/** `input_name`: the visible parts side by side in one row. */
function nameField(ctx: Ctx, e: FluentElement): string {
  const name = text(attrsOf(e).name);
  const cells: string[] = [];
  for (const [partName, part] of Object.entries(e.fields ?? {})) {
    if (!visible(part)) continue;
    const g = `<div class='ff-el-group ${placement(part, e)}'>${label(ctx, part, `ff_${ctx.form.id}_${name}_${partName}_`)}<div class='ff-el-input--content'>${partInput(part, `${name}[${partName}]`, `ff_${ctx.form.id}_${name}_${partName}_`)}</div></div>`;
    cells.push(cell(g));
  }
  return `<div data-type="name-element" data-name="${esc(name)}" class=" ff-field_container ff-name-field-wrapper"><div class='ff-t-container'>${cells.join("")}</div></div>`;
}

function partInput(part: FluentElement, name: string, id: string, keyName?: string): string {
  const a = attrsOf(part);
  const placeholder = text(a.placeholder);
  const value = text(a.value);
  const key = keyName === undefined ? "" : ` data-key_name="${esc(keyName)}"`;
  return `<input type="text" name="${esc(name)}"${value === "" ? "" : ` value="${esc(value)}"`} id="${esc(id)}" class="ff-el-form-control"${placeholder === "" ? "" : ` placeholder="${shown(placeholder)}"`}${key} aria-invalid="false" aria-required=${required(part) ? "true" : "false"}>`;
}

/** `address`: the visible parts, two to a row. */
function addressField(ctx: Ctx, e: FluentElement): string {
  const name = text(attrsOf(e).name);
  const parts = Object.entries(e.fields ?? {}).filter(([, part]) => visible(part));
  const rows: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const pair = parts
      .slice(i, i + 2)
      .map(([partName, part]) => cell(partControl(ctx, part, partName, name)));
    rows.push(`<div class='ff-t-container'>${pair.join("")}</div>`);
  }
  const heading = text(settingsOf(e).label);
  const classes = ["ff-name-address-wrapper", "fluent-address"];
  if (hasConditions(e)) classes.push("has-conditions");
  return `<div class="${classes.join(" ")}" data-type="address-element" data-name="${esc(name)}"><div class='ff-el-input--label'>${heading === "" ? "" : `<label aria-label="${esc(heading)}">${shown(heading)}</label>`}</div><div class='ff-el-input--content'>${rows.join("")}</div></div>`;
}

function container(ctx: Ctx, e: FluentElement): string {
  const columns = e.columns ?? [];
  const cells = columns.map((column, i) => {
    const width = Number(column.width);
    const style = Number.isFinite(width) && width > 0 ? ` style='flex-basis: ${width}%;'` : "";
    const inner = (column.fields ?? []).map((f) => element(ctx, f)).join("");
    return `<div class='ff-t-cell ff-t-column-${i + 1}'${style}>${inner}</div>`;
  });
  return `<div class='ff-t-container ff-column-container ff_columns_total_${columns.length} '>${cells.join("")}</div>`;
}

function customHtml(e: FluentElement): string {
  const classes = ["ff-el-group", "", "ff-custom_html"];
  if (hasConditions(e)) classes.push("has-conditions");
  const name = text(attrsOf(e).name) || text(settingsOf(e).admin_field_label);
  return `<div class='${classes.join(" ")}' tabindex='-1' data-name="${esc(name)}">${text(settingsOf(e).html_codes)}</div>`;
}

/** One element's markup. A conditional element is drawn with the class that hides it. */
function element(ctx: Ctx, e: FluentElement): string {
  const conditional = hasConditions(e);
  const wrap = (html: string): string =>
    conditional && !html.includes("has-conditions")
      ? html.replace(/^<div class='([^']*)'/, "<div class='$1 has-conditions'")
      : html;
  switch (e.element) {
    case "input_name":
      return nameField(ctx, e);
    case "input_text":
    case "input_email":
    case "input_number":
    case "input_url":
    case "input_password":
    case "phone": {
      const name = text(attrsOf(e).name);
      return wrap(labelled(ctx, e, inputControl(ctx, e), `ff_${ctx.form.id}_${name}`));
    }
    case "textarea":
      return wrap(textarea(ctx, e));
    case "select":
      return wrap(select(ctx, e));
    case "input_radio":
    case "input_checkbox":
      return wrap(checks(ctx, e));
    case "input_image":
    case "input_file":
      return wrap(upload(ctx, e));
    case "address":
      return addressField(ctx, e);
    case "container":
      return container(ctx, e);
    case "custom_html":
      return customHtml(e);
    case "input_hidden":
      return `<input type="hidden" name="${esc(attrsOf(e).name)}" value="${esc(attrsOf(e).value)}">`;
    default:
      ctx.unsupported.push({ element: e.element, label: text(settingsOf(e).label) });
      return "";
  }
}

/** A style map of the submit button as CSS declarations: the plugin dashes each capital run and skips empty values (0 stays). */
function declarationsOf(styles: unknown): string {
  if (!isRecord(styles)) return "";
  return (
    Object.entries(styles)
      // PHP skips a falsy value but "0" (a string); here only "" , 0, false and null are falsy.
      .filter(([, value]) => Boolean(value))
      .map(([name, value]) => {
        const shown = name === "borderRadius" ? `${text(value)}px` : text(value);
        return `${name.replace(/[A-Z]([A-Z](?![a-z]))*/g, "-$&").toLowerCase()}:${shown};`;
      })
      .join("")
  );
}

/** Whether the button is the author's own look (`button_style` empty or absent: the plugin compares loosely). */
const customButton = (s: Record<string, unknown>): boolean =>
  s.button_style === undefined || s.button_style === null || s.button_style === "";

/**
 * The rules the plugin's submit button prints for itself (into the footer, `SubmitButton::render`):
 * its colours for the default look, and for a custom button the "normal" and "hover" styles the
 * author set. Without them the label takes the stylesheet's own colour (dark text on a red button
 * on the pilot's estimate form).
 */
export function submitCss(form: { id: number }, e: FluentElement | undefined): string {
  if (e === undefined) return "";
  const s = settingsOf(e);
  if (s.button_style === "no_style") return "";
  const selector = `form.fluent_form_${form.id} .ff-btn-submit`;
  if (customButton(s)) {
    const normal = declarationsOf(s.normal_styles);
    const hover = declarationsOf(s.hover_styles);
    return [
      normal === "" ? "" : `${selector}.wpf_has_custom_css { ${normal} }`,
      hover === "" ? "" : `${selector}.wpf_has_custom_css:hover { ${hover} }`,
    ]
      .filter((rule) => rule !== "")
      .join("");
  }
  const background = text(s.background_color).replaceAll("#1a7efb", "var(--fluentform-primary)");
  return `${selector}:not(.ff_btn_no_style) { background-color: ${background}; color: ${text(s.color)}; }`;
}

function submit(e: FluentElement | undefined): string {
  const s = e === undefined ? {} : settingsOf(e);
  const ui = isRecord(s.button_ui) ? s.button_ui : {};
  const textOf = text(ui.text) || text(s.btn_text) || "Submit";
  const align = text(s.align) || "left";
  const size = text(ui.size) || text(s.button_size) || "md";
  const custom = e !== undefined && customButton(s);
  const look = s.button_style === "no_style" ? "ff_btn_no_style" : "ff_btn_style";
  const old = e !== undefined && s.button_style === undefined ? " ff-btn-primary" : "";
  const classes = `ff-btn ff-btn-submit${old} ff-btn-${esc(size)} ${look}${custom ? " wpf_has_custom_css" : ""}`;
  return `<div class='ff-el-group ff-text-${esc(align)} ff_submit_btn_wrapper'><button type="submit" class="${classes}" aria-label="${esc(textOf)}">${shown(textOf)}</button></div>`;
}

/** The form as the plugin prints it, minus the scripts, the nonce fields and the bot widget. */
export function renderFluentForm(
  form: FluentForm,
  themeStyle?: string,
  turnstile?: TurnstileOptions,
): RenderedForm {
  const layout = form.layout;
  const placementName = text(layout.labelPlacement) || "top";
  const ctx: Ctx = {
    form,
    unsupported: [],
    asterisk: text(layout.asteriskPlacement) || "asterisk-right",
  };
  const body = form.fields.map((f) => element(ctx, f)).join("");
  // The block can name a style of its own (`themeStyle`); the form's own choice applies otherwise.
  const style = themeStyle !== undefined && themeStyle !== "" ? themeStyle : form.style;
  const styled = style !== "";
  const wrapper = [
    "fluentform",
    "ff-default",
    `fluentform_wrapper_${form.id}`,
    styled ? `${style}_wrap` : "",
  ].filter((c) => c !== "");
  const formClasses = [
    "frm-fluent-form",
    `fluent_form_${form.id}`,
    `ff-el-form-${placementName}`,
    styled ? style : "",
  ].filter((c) => c !== "");
  const html = `<form data-form_id="${form.id}" id="fluentform_${form.id}" class="${formClasses.join(" ")}" data-wp2jx="fluentform:${form.id}"><fieldset style="border: none!important;margin: 0!important;padding: 0!important;background-color: transparent!important;box-shadow: none!important;outline: none!important; min-inline-size: 100%;"><legend class="ff_screen_reader_title" style="display: block; margin: 0!important;padding: 0!important;height: 0!important;text-indent: -999999px;width: 0!important;overflow:hidden;">${esc(form.title)}</legend>${body}${submit(form.submitButton)}${turnstile === undefined ? "" : turnstileMarkup(form, turnstile)}</fieldset></form>`;
  return {
    className: wrapper.join(" "),
    html,
    unsupported: ctx.unsupported,
    css: [styled ? (form.styles.get(style) ?? "") : "", submitCss(form, form.submitButton)]
      .filter((c) => c !== "")
      .join("\n"),
  };
}

// ── Placeholders ─────────────────────────────────────────────────────────────────────────────────

/** The forms each site's pages used, by id: the project assembler ships their stylesheets. */
const usedBySite = new WeakMap<
  object,
  Map<string, { id: number; css: string; turnstile: boolean }>
>();

/** The forms drawn so far for a site and the styler rules of the style each was drawn in, in the order first drawn. */
export function usedForms(site: object): { id: number; css: string; turnstile: boolean }[] {
  return [...(usedBySite.get(site)?.values() ?? [])];
}

/** The form a `fluentform` shortcode or the Fluent Forms block names, when the placeholder is one of those. */
function formIdOf(placeholder: Placeholder): { id: number; themeStyle?: string } | undefined {
  if (placeholder.kind === "shortcode" && placeholder.attrs["data-shortcode"] === "fluentform") {
    const raw = placeholder.attrs["data-attributes"];
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const id = isRecord(parsed) ? Number(parsed.id) : Number.NaN;
      return Number.isInteger(id) && id > 0 ? { id } : undefined;
    } catch {
      return undefined;
    }
  }
  if (placeholder.kind === "block" && placeholder.block === "fluentfom/guten-block") {
    const id = Number(placeholder.blockAttrs.formId);
    const themeStyle = placeholder.blockAttrs.themeStyle;
    return Number.isInteger(id) && id > 0
      ? { id, ...(typeof themeStyle === "string" ? { themeStyle } : {}) }
      : undefined;
  }
  return undefined;
}

/** Report entries a resolver can add; the caller supplies where and for which page. */
export type SayForm = (entry: {
  severity: "warn" | "info";
  code: string;
  message: string;
  data?: Record<string, unknown>;
}) => void;

/**
 * The element for a placeholder that stands for a Fluent Forms form, or undefined when it is not
 * one or the form is not in the site (the caller's neutral stand-in then holds its place).
 */
export function fluentFormFor(
  site: {
    forms?: ReadonlyMap<number, FluentForm>;
    model?: { options: ReadonlyMap<string, string> };
  },
  placeholder: Placeholder,
  say: SayForm,
): JxElement | undefined {
  const found = formIdOf(placeholder);
  if (found === undefined) return undefined;
  const { id } = found;
  const form = site.forms?.get(id);
  if (form === undefined) {
    say({
      severity: "warn",
      code: "form.missing",
      message: `The Fluent Forms form ${id} is not a published form in the database, so nothing could be drawn for it.`,
      data: { form: id },
    });
    return undefined;
  }
  const turnstile = turnstileOf(site.model?.options);
  const rendered = renderFluentForm(form, found.themeStyle, turnstile);
  const used =
    usedBySite.get(site) ?? new Map<string, { id: number; css: string; turnstile: boolean }>();
  used.set(`${id}|${rendered.className}`, {
    id,
    css: rendered.css,
    turnstile: turnstile !== undefined,
  });
  usedBySite.set(site, used);
  say({
    severity: "warn",
    code: "form.not-submittable",
    message: `The form "${form.title}" is drawn as the plugin draws it, but it cannot be submitted: a static site has no server to receive it${turnstile === undefined ? "" : ". The plugin's bot check is Cloudflare's own widget, drawn by the script the head links with the site's key (the key only works on the site's own domain)"}.`,
    data: { form: id, title: form.title },
  });
  for (const item of rendered.unsupported) {
    say({
      severity: "warn",
      code: "form.element-unsupported",
      message: `The form "${form.title}" has a ${item.element} element${item.label === "" ? "" : ` (${item.label})`}, which is not drawn.`,
      data: { form: id, element: item.element },
    });
  }
  return {
    tagName: "div",
    className: rendered.className,
    attributes: { "data-wp2jx": `fluentform:${id}` },
    innerHTML: escapeTemplate(rendered.html),
  };
}

// ── The stylesheet ───────────────────────────────────────────────────────────────────────────────

export const FLUENTFORM_CSS_PATH = "public/css/fluentform.css";

/** The plugin's two public stylesheets, in the order the plugin prints them, relative to the site root. */
const PLUGIN_CSS = [
  "wp-content/plugins/fluentform/assets/css/fluent-forms-public.css",
  "wp-content/plugins/fluentform/assets/css/fluentform-public-default.css",
];

export async function readPluginFile(from: string, rel: string): Promise<string | null> {
  try {
    if (/^https?:\/\//i.test(from)) {
      const response = await fetch(new URL(rel, `${from.replace(/\/+$/, "")}/`).href);
      return response.ok ? await response.text() : null;
    }
    const file = Bun.file(`${from.replace(/\/+$/, "")}/${rel}`);
    return (await file.exists()) ? await file.text() : null;
  } catch {
    return null;
  }
}

/**
 * The stylesheet for the forms the pages draw: the plugin's own public stylesheets (read from the
 * site checkout or the live site `from`) and each used form's styler rules. Undefined when no form is
 * drawn. A plugin file that cannot be read is reported and left out: the markup then has only the
 * styles the page's own CSS gives it.
 */
export async function fluentFormStylesheet(
  forms: readonly { id: number; css: string }[],
  from: string | undefined,
  report: {
    add(entry: {
      severity: "warn";
      code: string;
      message: string;
      where: string;
      data?: Record<string, unknown>;
    }): void;
  },
): Promise<{ path: string; content: string } | undefined> {
  if (forms.length === 0) return undefined;
  const parts: string[] = [];
  for (const rel of PLUGIN_CSS) {
    const css = from === undefined ? null : await readPluginFile(from, rel);
    if (css === null) {
      report.add({
        severity: "warn",
        code: "form.css-missing",
        message: `The plugin stylesheet ${rel} was not found${from === undefined ? " (no plugin source was given)" : ` at ${from}`}, so the drawn form has none of the plugin's styles.`,
        where: "plugin:fluentform",
        data: { file: rel },
      });
      continue;
    }
    parts.push(`/* ${rel} */\n${css.trim()}`);
  }
  for (const form of forms) {
    if (form.css.trim() !== "")
      parts.push(`/* Fluent Forms styler: form ${form.id} */\n${form.css.trim()}`);
  }
  return { path: FLUENTFORM_CSS_PATH, content: `${parts.join("\n\n")}\n` };
}
