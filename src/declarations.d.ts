declare module "*.yaml" {
  const content: string;
  export default content;
}

declare global {
  interface Window {
    moment(inp?: moment.MomentInput, strict?: boolean): moment.Moment;
    moment(inp?: moment.MomentInput, format?: moment.MomentFormatSpecification, strict?: boolean): moment.Moment;
    moment(inp?: moment.MomentInput, format?: moment.MomentFormatSpecification, language?: string, strict?: boolean): moment.Moment;
  }
}
