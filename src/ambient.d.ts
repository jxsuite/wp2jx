// @jxsuite/schema ships `.ts` sources, so tsc type-checks them from node_modules, and they import
// the @webref data packages, which publish no declarations. Declaring them here keeps the
// project's own typecheck about our code.
declare module "@webref/elements" {
  export function listAll(): Promise<Record<string, any>>;
}
declare module "@webref/css" {
  const css: { listAll(): Promise<any> };
  export default css;
}
declare module "@webref/idl" {
  const idl: { parseAll(): Promise<Record<string, any>> };
  export default idl;
}
