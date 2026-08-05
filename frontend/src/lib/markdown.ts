/**
 * Lightweight GFM (GitHub Flavored Markdown) parser for Kriya issue descriptions.
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseInline(text: string): string {
  let out = escapeHtml(text);

  // Inline code: `code`
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold: **text** or __text__
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");

  // Italic: *text* or _text_
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/_([^_]+)_/g, "<em>$1</em>");

  // Strikethrough: ~~text~~
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // Links: [text](url)
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  );

  return out;
}

export function parseMarkdown(md: string): string {
  if (!md || !md.trim()) return "";

  const lines = md.split(/\r?\n/);
  let html = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 1. Code blocks ```
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      let code = "";
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code += escapeHtml(lines[i]) + "\n";
        i++;
      }
      html += `<pre><code class="${lang}">${code.trimEnd()}</code></pre>`;
      i++;
      continue;
    }

    // 2. GFM Tables (| cell | cell |)
    if (line.trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i].trim());
        i++;
      }

      if (tableLines.length > 0) {
        let hasHeader = false;
        let headerRow = "";
        let bodyRows = "";

        // Check if second line (or first line) is a divider line like |---|---|
        let startIdx = 0;
        if (
          tableLines.length >= 2 &&
          /^[|\s-:]+$/.test(tableLines[1])
        ) {
          hasHeader = true;
          const headerCells = tableLines[0]
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim());
          headerRow =
            "<tr>" +
            headerCells.map((c) => `<th>${parseInline(c)}</th>`).join("") +
            "</tr>";
          startIdx = 2;
        } else if (/^[|\s-:]+$/.test(tableLines[0])) {
          // If the first row itself is a divider like |---|---|---|
          startIdx = 1;
        }

        for (let j = startIdx; j < tableLines.length; j++) {
          if (/^[|\s-:]+$/.test(tableLines[j])) continue;
          const cells = tableLines[j]
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim());
          bodyRows +=
            "<tr>" +
            cells.map((c) => `<td>${parseInline(c)}</td>`).join("") +
            "</tr>";
        }

        const headHtml = hasHeader ? `<thead>${headerRow}</thead>` : "";
        const bodyHtml = bodyRows ? `<tbody>${bodyRows}</tbody>` : "";
        html += `<div class="table-wrapper"><table>${headHtml}${bodyHtml}</table></div>`;
      }
      continue;
    }

    // 3. Headings (# H1, ## H2, ### H3, #### H4)
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const content = parseInline(headingMatch[2]);
      html += `<h${level}>${content}</h${level}>`;
      i++;
      continue;
    }

    // 4. Blockquotes (> text)
    if (line.trim().startsWith(">")) {
      let quoteText = "";
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        quoteText += lines[i].trim().replace(/^>\s?/, "") + "\n";
        i++;
      }
      html += `<blockquote>${parseMarkdown(quoteText)}</blockquote>`;
      continue;
    }

    // 5. Task lists & Unordered/Ordered lists (- [ ] item, - item, * item, 1. item)
    const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const isOrdered = /^\d+\./.test(listMatch[2]);
      const tag = isOrdered ? "ol" : "ul";
      let listItems = "";

      while (i < lines.length) {
        const itemMatch = lines[i].match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
        if (!itemMatch) break;

        let content = itemMatch[3];
        const taskMatch = content.match(/^\[([ xX])\]\s+(.*)$/);

        if (taskMatch) {
          const checked = taskMatch[1].toLowerCase() === "x";
          content = `<input type="checkbox" disabled ${checked ? "checked" : ""} /> ${parseInline(taskMatch[2])}`;
        } else {
          content = parseInline(content);
        }

        listItems += `<li class="${taskMatch ? "task-list-item" : ""}">${content}</li>`;
        i++;
      }

      html += `<${tag}>${listItems}</${tag}>`;
      continue;
    }

    // 6. Horizontal rule (--- or ***)
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      html += "<hr />";
      i++;
      continue;
    }

    // 7. Empty lines
    if (!line.trim()) {
      i++;
      continue;
    }

    // 8. Paragraphs
    let paragraph = "";
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("```") &&
      !lines[i].trim().startsWith("#") &&
      !lines[i].trim().startsWith(">") &&
      !lines[i].trim().startsWith("|") &&
      !lines[i].match(/^(\s*)([-*+]|\d+\.)\s+/) &&
      !/^(\*{3,}|-{3,}|_{3,})$/.test(lines[i].trim())
    ) {
      paragraph += (paragraph ? "<br />" : "") + parseInline(lines[i]);
      i++;
    }

    if (paragraph) {
      html += `<p>${paragraph}</p>`;
    }
  }

  return html;
}
