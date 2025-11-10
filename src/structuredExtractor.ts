import { TFile } from "obsidian";

export interface StructuredContent {
  metadata: {
    sourcePath: string;
    renderedAt: string;
    format: string;
    version: string;
  };
  frontmatter: Record<string, any>;
  content: ContentBlock[];
}

export type ContentBlock =
  | HeadingBlock
  | ParagraphBlock
  | TableBlock
  | ListBlock
  | CodeBlock
  | CalloutBlock;

export interface HeadingBlock {
  type: "heading";
  level: number;
  text: string;
}

export interface ParagraphBlock {
  type: "paragraph";
  text: string;
}

export interface TableBlock {
  type: "table";
  title?: string;
  headers: string[];
  rows: string[][];
}

export interface ListBlock {
  type: "list";
  style: "ordered" | "unordered";
  items: string[];
}

export interface CodeBlock {
  type: "code";
  language?: string;
  code: string;
}

export interface CalloutBlock {
  type: "callout";
  calloutType: string;
  title?: string;
  content: string;
}

export class StructuredExtractor {
  extractStructured(
    file: TFile,
    frontmatter: Record<string, any>,
    contentEl: HTMLElement
  ): StructuredContent {
    const content: ContentBlock[] = [];
    let currentTable: TableBlock | null = null;

    const processNode = (node: Node): void => {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }

      const el = node as HTMLElement;
      const tagName = el.tagName.toLowerCase();

      // Skip frontmatter display
      if (el.classList.contains("frontmatter")) {
        return;
      }

      // Handle headings
      if (tagName.match(/^h[1-6]$/)) {
        const level = parseInt(tagName[1]);
        const text = el.textContent?.trim() || "";
        if (text) {
          content.push({
            type: "heading",
            level,
            text,
          });
        }
        return;
      }

      // Handle tables
      if (tagName === "table") {
        const tableBlock = this.extractTable(el);
        if (tableBlock) {
          content.push(tableBlock);
        }
        return;
      }

      // Handle lists
      if (tagName === "ul") {
        const items: string[] = [];
        el.querySelectorAll("li").forEach((li) => {
          const text = li.textContent?.trim();
          if (text) items.push(text);
        });
        if (items.length > 0) {
          content.push({
            type: "list",
            style: "unordered",
            items,
          });
        }
        return;
      }

      if (tagName === "ol") {
        const items: string[] = [];
        el.querySelectorAll("li").forEach((li) => {
          const text = li.textContent?.trim();
          if (text) items.push(text);
        });
        if (items.length > 0) {
          content.push({
            type: "list",
            style: "ordered",
            items,
          });
        }
        return;
      }

      // Handle code blocks
      if (tagName === "pre") {
        const codeEl = el.querySelector("code");
        if (codeEl) {
          const code = codeEl.textContent || "";
          const languageClass = Array.from(codeEl.classList).find((c) =>
            c.startsWith("language-")
          );
          const language = languageClass?.replace("language-", "");

          content.push({
            type: "code",
            language,
            code,
          });
        }
        return;
      }

      // Handle callouts
      if (el.classList.contains("callout")) {
        const calloutType =
          Array.from(el.classList)
            .find((c) => c.startsWith("callout-"))
            ?.replace("callout-", "") || "note";
        const titleEl = el.querySelector(".callout-title");
        const title = titleEl?.textContent?.trim();
        const contentText = el.textContent?.trim() || "";

        content.push({
          type: "callout",
          calloutType,
          title,
          content: contentText,
        });
        return;
      }

      // Handle paragraphs
      if (tagName === "p") {
        const text = el.textContent?.trim();
        if (text && !el.querySelector("table, ul, ol, pre")) {
          content.push({
            type: "paragraph",
            text,
          });
        }
        return;
      }

      // Recursively process children for divs and other containers
      if (tagName === "div" || tagName === "section" || tagName === "article") {
        for (const child of Array.from(el.children)) {
          processNode(child);
        }
      }
    };

    // Process all top-level children
    for (const child of Array.from(contentEl.children)) {
      processNode(child);
    }

    return {
      metadata: {
        sourcePath: file.path,
        renderedAt: new Date().toISOString(),
        format: "json",
        version: "1.0",
      },
      frontmatter,
      content,
    };
  }

  private extractTable(table: HTMLElement): TableBlock | null {
    const headers: string[] = [];
    const rows: string[][] = [];

    // Extract headers
    const thead = table.querySelector("thead");
    if (thead) {
      const headerCells = thead.querySelectorAll("th");
      headerCells.forEach((cell) => {
        headers.push(cell.textContent?.trim() || "");
      });
    }

    // Extract data rows
    const tbody = table.querySelector("tbody") || table;
    const dataRows = tbody.querySelectorAll("tr");

    dataRows.forEach((row) => {
      const cells = row.querySelectorAll("td, th");
      if (cells.length === 0) return;

      const rowData: string[] = [];
      cells.forEach((cell) => {
        rowData.push(cell.textContent?.trim() || "");
      });
      rows.push(rowData);
    });

    // If no headers found in thead, use first row as headers
    if (headers.length === 0 && rows.length > 0) {
      headers.push(...rows[0]);
      rows.shift();
    }

    if (headers.length === 0 && rows.length === 0) {
      return null;
    }

    return {
      type: "table",
      headers,
      rows,
    };
  }
}
