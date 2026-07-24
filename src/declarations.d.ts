declare module "*.yaml" {
  const content: string;
  export default content;
}

// json-logic-js ships no type declarations, and the DefinitelyTyped ones model
// `apply` as (logic: RulesLogic) => any — the strict RulesLogic input union
// rejects user-supplied queries and our custom glob/regexp operators, while the
// `any` return defeats the no-unsafe-* lint rules. These narrower unknown-based
// signatures match how the library is actually used here.
declare module "json-logic-js" {
  const jsonLogic: {
    apply: (logic: unknown, data?: unknown) => unknown;
    add_operation: (
      name: string,
      code: (...args: unknown[]) => unknown
    ) => void;
  };
  export default jsonLogic;
}

declare global {
  interface Window {
    moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;
    moment(inp?: moment.MomentInput, format?: moment.MomentFormatSpecification, strict?: boolean): moment.Moment;
    moment(inp?: moment.MomentInput, format?: moment.MomentFormatSpecification, language?: string, strict?: boolean): moment.Moment;
  }
}
