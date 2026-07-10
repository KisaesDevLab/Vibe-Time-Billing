// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Minimal, dependency-free Markdown → HTML for firm-authored snippets (ad-hoc
// client emails, etc.). Supports headings, bold/italic, links, unordered/
// ordered lists, and paragraphs. Escapes HTML so user input can't inject markup.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === '') {
      closeList();
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      closeList();
      const level = Math.min(6, h[1]!.length);
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
      continue;
    }
    const ul = /^[-*]\s+(.*)$/.exec(line);
    if (ul) {
      if (list !== 'ul') {
        closeList();
        out.push('<ul>');
        list = 'ul';
      }
      out.push(`<li>${inline(ul[1]!)}</li>`);
      continue;
    }
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ol) {
      if (list !== 'ol') {
        closeList();
        out.push('<ol>');
        list = 'ol';
      }
      out.push(`<li>${inline(ol[1]!)}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}
