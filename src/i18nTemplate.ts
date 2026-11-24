/**
 * Rendering for translation templates.
 *
 * A template is plain text with `{name}` placeholders. `t()` produces the
 * text; `renderTemplate` fills an element with it, delegating each placeholder
 * to a renderer. That keeps links and inline code as DOM nodes built by the
 * caller, so no markup lives in the dictionaries and a translator can move a
 * placeholder anywhere in the sentence.
 */

export type TemplatePart =
  | { kind: "text"; value: string }
  | { kind: "placeholder"; name: string };

/** Placeholder names are identifiers so `{1}` and `{}` stay literal text. */
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** Split a template into literal text and named placeholders. */
export function splitTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push({ kind: "text", value: template.slice(last, index) });
    }
    parts.push({ kind: "placeholder", name: match[1] });
    last = index + match[0].length;
  }
  if (last < template.length) {
    parts.push({ kind: "text", value: template.slice(last) });
  }
  return parts;
}

/** The placeholder names a template uses, in order of appearance. */
export function placeholderNames(template: string): string[] {
  return splitTemplate(template)
    .filter(
      (part): part is { kind: "placeholder"; name: string } =>
        part.kind === "placeholder",
    )
    .map((part) => part.name);
}

/** Builds the content for one placeholder, e.g. an `<a>` or a `<code>`. */
export type TemplateRenderer = (parent: HTMLElement) => void;

/**
 * Render a template into `parent`, calling the matching renderer for each
 * placeholder. A placeholder with no renderer is left visible rather than
 * dropped, so a missing renderer is obvious instead of silently losing text.
 */
export function renderTemplate(
  parent: HTMLElement,
  template: string,
  renderers: Record<string, TemplateRenderer>,
): void {
  for (const part of splitTemplate(template)) {
    if (part.kind === "text") {
      if (part.value) parent.createSpan({ text: part.value });
      continue;
    }
    const render = renderers[part.name];
    if (render) {
      render(parent);
    } else {
      parent.createSpan({ text: `{${part.name}}` });
    }
  }
}
