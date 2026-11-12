/**
 * The scope a test evaluates a binding over, the way the build does: the page's `state` with the
 * formulas `project.json` holds (`src/formulas.ts`) in it, as functions. A binding the converter
 * writes may call one (`state.formatDate(state.entry.data.date, {…})`), and a bare `state` has none.
 */
import { formulaFunctions } from "../../src/formulas.ts";

/** `state` with the converter's formulas in it; what `state` already holds under a formula's name wins. */
export function withFormulas<T>(state: T): T {
  const scope = { ...(state as object) } as T & object;
  return { ...formulaFunctions(scope), ...scope };
}
