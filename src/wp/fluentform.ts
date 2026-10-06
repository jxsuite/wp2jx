/**
 * Fluent Forms: the forms a site's pages embed, read from the plugin's own tables.
 *
 * A form is one row of `fluentform_forms` (`form_fields` is JSON: the elements in order, with their
 * labels, placeholders, options and column widths) plus rows of `fluentform_form_meta`; the one meta
 * key that matters for what a visitor sees is `ffs_custom`, the stylesheet the plugin's form styler
 * generated and prints inline in the page (every rule begins `.fluentform_wrapper_<id>.ffs_custom_wrap`).
 * Nothing else the plugin stores (notifications, integrations, entries) belongs to a static site.
 *
 * The tables are absent on a site without the plugin, and a site may not have granted the account
 * that reads them: absence is an empty list, not a failure.
 */
import { tableExists } from "./db.ts";
import type { WpDb } from "../types.ts";

/** One element of a form, as the plugin stores it. Only what the renderer reads is typed. */
export interface FluentElement {
  element: string;
  attributes?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  /** A composite element's parts (`input_name`, `address`): keyed by part name. */
  fields?: Record<string, FluentElement>;
  /** A container's columns. */
  columns?: { width?: number; fields?: FluentElement[] }[];
  editor_options?: Record<string, unknown>;
}

export interface FluentForm {
  id: number;
  title: string;
  fields: FluentElement[];
  submitButton: FluentElement | undefined;
  /** The form styler's generated stylesheets by style name (`ffs_custom`, `ffs_classic`…), the empty ones left out. */
  styles: ReadonlyMap<string, string>;
  /** The style the form uses unless the embedding block names another (`_ff_selected_style`; `ffs_default` for none). */
  style: string;
  /** `formSettings.layout`: label placement, help message placement, asterisk placement. */
  layout: Record<string, unknown>;
}

type Row = Record<string, unknown>;

const text = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Every published form of the site, by id. */
export async function loadFluentForms(db: WpDb): Promise<Map<number, FluentForm>> {
  const forms = new Map<number, FluentForm>();
  const columns = ["id", "title", "status", "form_fields"];
  if (!(await tableExists(db, "fluentform_forms", columns))) return forms;
  const rows = await db.query<Row>(
    `select id, title, status, form_fields from ${db.table("fluentform_forms")} order by id`,
  );
  const meta = new Map<number, Map<string, string>>();
  if (await tableExists(db, "fluentform_form_meta", ["form_id", "meta_key", "value"])) {
    const metaRows = await db.query<Row>(
      `select form_id, meta_key, value from ${db.table("fluentform_form_meta")}
        where meta_key like 'ffs%' or meta_key in ('_ff_selected_style', 'formSettings') order by id`,
    );
    for (const row of metaRows) {
      const id = Number(row.form_id);
      const own = meta.get(id) ?? new Map<string, string>();
      // Later rows win: the plugin updates by inserting when it cannot find the key, so the newest is the one in force.
      own.set(text(row.meta_key), text(row.value));
      meta.set(id, own);
    }
  }
  for (const row of rows) {
    if (text(row.status) !== "published") continue;
    const parsed = parseJson(row.form_fields);
    if (!isRecord(parsed) || !Array.isArray(parsed.fields)) continue;
    const id = Number(row.id);
    const own = meta.get(id);
    const settings = parseJson(own?.get("formSettings"));
    const layout = isRecord(settings) && isRecord(settings.layout) ? settings.layout : {};
    const submit = isRecord(parsed.submitButton)
      ? (parsed.submitButton as unknown as FluentElement)
      : undefined;
    forms.set(id, {
      id,
      title: text(row.title),
      fields: parsed.fields.filter(isRecord) as unknown as FluentElement[],
      submitButton: submit,
      styles: new Map(
        [...(own ?? [])].filter(([key, value]) => key.startsWith("ffs_") && value.trim() !== ""),
      ),
      style: own?.get("_ff_selected_style") || "ffs_default",
      layout,
    });
  }
  return forms;
}
