/**
 * `src/wp/fluentform.ts` over the pilot's real Fluent Forms rows (tests/data/fluentform-fineline.json).
 */
import { describe, expect, test } from "bun:test";
import { openDb } from "../../src/wp/db.ts";
import { loadFluentForms } from "../../src/wp/fluentform.ts";
import { dump, openFormDb } from "../helpers/fluentform-db.ts";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

describe("loadFluentForms", () => {
  test("reads every published form with its elements, layout and submit button", async () => {
    const opened = await openFormDb();
    try {
      const forms = await loadFluentForms(opened.db);
      expect([...forms.keys()]).toEqual([1, 3, 5, 6]);
      const quick = forms.get(6)!;
      expect(quick.title).toBe("Quick Estimate");
      expect(quick.fields.map((f) => f.element)).toEqual(["input_name", "container", "container"]);
      expect(quick.submitButton?.element).toBe("button");
      expect(quick.layout).toMatchObject({
        labelPlacement: "top",
        asteriskPlacement: "asterisk-right",
      });
    } finally {
      await opened.close();
    }
  });

  test("keeps the form styler's stylesheets by style name and the style the form selected", async () => {
    const opened = await openFormDb();
    try {
      const forms = await loadFluentForms(opened.db);
      // the selected style is what `_ff_selected_style` says; a form that never chose one is the plugin's default
      expect(forms.get(6)!.style).toBe("ffs_custom");
      expect(forms.get(3)!.style).toBe("ffs_custom");
      expect(forms.get(5)!.style).toBe("ffs_default");
      expect(forms.get(1)!.style).toBe("ffs_default");
      expect(forms.get(6)!.styles.get("ffs_custom")).toContain(
        ".fluentform_wrapper_6.ffs_custom_wrap .ff_submit_btn_wrapper .ff-btn-submit",
      );
      // an empty stylesheet is no stylesheet; a form can hold several (the embedding block picks one)
      expect(forms.get(1)!.styles.has("ffs_default")).toBe(false);
      expect(forms.get(1)!.styles.get("ffs_classic")).toContain(
        "fluentform_wrapper_1.ffs_classic_wrap",
      );
    } finally {
      await opened.close();
    }
  });

  test("the newest meta row of a key wins, an unpublished or unreadable form is left out", async () => {
    const opened = await openFormDb((raw) => {
      const t = `${dump.prefix}fluentform_form_meta`;
      raw
        .query(`insert into ${t} (form_id, meta_key, value) values (6, 'ffs_custom', '.newest{}')`)
        .run();
      raw.run(`update ${dump.prefix}fluentform_forms set status = 'unpublished' where id = 1`);
      raw.run(`update ${dump.prefix}fluentform_forms set form_fields = '{not json' where id = 5`);
      raw.run(
        `update ${dump.prefix}fluentform_forms set form_fields = '{"no":"fields"}' where id = 3`,
      );
    });
    try {
      const forms = await loadFluentForms(opened.db);
      expect([...forms.keys()]).toEqual([6]);
      expect(forms.get(6)!.styles.get("ffs_custom")).toBe(".newest{}");
    } finally {
      await opened.close();
    }
  });

  test("a site without the plugin has no forms, and a missing meta table leaves the forms unstyled", async () => {
    const root = resolve(import.meta.dir, "../..");
    mkdirSync(join(root, ".dev/tmp"), { recursive: true });
    const dir = mkdtempSync(join(root, ".dev/tmp/noforms-"));
    try {
      const path = join(dir, "x.sqlite");
      const raw = new Database(path);
      raw.run("create table wp_options (option_name text)");
      raw.run("create table wp_postmeta (post_id integer)");
      raw.run("create table wp_posts (id integer)");
      raw.close();
      const bare = await openDb(`sqlite:${path}`, { prefix: "wp_" });
      expect((await loadFluentForms(bare)).size).toBe(0);
      await bare.close();

      const only = new Database(path);
      only.run(
        "create table wp_fluentform_forms (id integer primary key, title text, status text, type text, form_fields text)",
      );
      only
        .query("insert into wp_fluentform_forms values (9, 'Lone', 'published', 'form', ?)")
        .run(JSON.stringify({ fields: [{ element: "input_text", attributes: { name: "a" } }] }));
      only.close();
      const lone = await openDb(`sqlite:${path}`, { prefix: "wp_" });
      const forms = await loadFluentForms(lone);
      await lone.close();
      expect(forms.get(9)).toMatchObject({ title: "Lone", style: "ffs_default", layout: {} });
      expect(forms.get(9)!.styles.size).toBe(0);
      expect(forms.get(9)!.submitButton).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
