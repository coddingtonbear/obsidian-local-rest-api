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

// @types/node-forge omits the IP helpers that node-forge's util module
// actually exports (lib/util.js). Both return null for unparseable input.
declare module "node-forge" {
  namespace util {
    /** Binary bytes (4 for IPv4, 16 for IPv6) of an address, or null if it is not one. */
    function bytesFromIP(ip: string): string | null;
    /** Dotted/colon text of 4- or 16-byte binary address, or null for any other length. */
    function bytesToIP(bytes: string): string | null;
  }
}
