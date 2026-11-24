import { placeholderNames, renderTemplate, splitTemplate } from "./i18nTemplate";

describe("splitTemplate", () => {
  it("returns one text part when there are no placeholders", () => {
    expect(splitTemplate("plain text")).toEqual([
      { kind: "text", value: "plain text" },
    ]);
  });

  it("splits around placeholders and keeps the surrounding text", () => {
    expect(splitTemplate("a {b} c {d}!")).toEqual([
      { kind: "text", value: "a " },
      { kind: "placeholder", name: "b" },
      { kind: "text", value: " c " },
      { kind: "placeholder", name: "d" },
      { kind: "text", value: "!" },
    ]);
  });

  it("leaves braces that are not identifiers as text", () => {
    expect(splitTemplate("{} and {1}")).toEqual([
      { kind: "text", value: "{} and {1}" },
    ]);
  });

  it("keeps a placeholder at the start and at the end", () => {
    expect(splitTemplate("{a}x{b}")).toEqual([
      { kind: "placeholder", name: "a" },
      { kind: "text", value: "x" },
      { kind: "placeholder", name: "b" },
    ]);
  });
});

describe("placeholderNames", () => {
  it("lists the names in order, repeats included", () => {
    expect(placeholderNames("{a} {b} {a}")).toEqual(["a", "b", "a"]);
  });

  it("returns nothing for plain text", () => {
    expect(placeholderNames("no placeholders")).toEqual([]);
  });
});

describe("renderTemplate", () => {
  function fakeParent(): { parent: HTMLElement; calls: string[] } {
    const calls: string[] = [];
    const parent = {
      createSpan: (options: { text: string }) => {
        calls.push(`text:${options.text}`);
        return undefined;
      },
      createEl: (tag: string, options: { text?: string }) => {
        calls.push(`el:${tag}:${options.text ?? ""}`);
        return undefined;
      },
    };
    return { parent: parent as unknown as HTMLElement, calls };
  }

  it("renders text and delegates placeholders to their renderer", () => {
    const { parent, calls } = fakeParent();

    renderTemplate(parent, "see {link} now", {
      link: (el) => {
        el.createEl("a", { text: "Docs" });
      },
    });

    expect(calls).toEqual(["text:see ", "el:a:Docs", "text: now"]);
  });

  it("leaves a placeholder with no renderer visible", () => {
    const { parent, calls } = fakeParent();

    renderTemplate(parent, "x {missing} y", {});

    expect(calls).toEqual(["text:x ", "text:{missing}", "text: y"]);
  });

  it("does not create empty text nodes", () => {
    const { parent, calls } = fakeParent();

    renderTemplate(parent, "{a}", {
      a: (el) => {
        el.createEl("code", { text: "H" });
      },
    });

    expect(calls).toEqual(["el:code:H"]);
  });
});
