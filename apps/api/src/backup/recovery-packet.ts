// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Recovery Packet composer. Turns the operator's Recovery Kit sheet
// (RECOVERY-KIT.txt — page 1, all secrets) plus the recovery guide
// (RECOVERY_GUIDE_MD) into one self-contained, print-ready HTML document that
// `renderHtmlToPdf` turns into the downloadable PDF.
//
// Everything is inlined (system fonts, no images, no external assets) so it
// passes the renderer's SSRF guard and prints identically offline.
//
// The markdown converter is intentionally small and handles exactly the
// constructs the guide uses: h1–h3, tables, fenced code, inline `code`,
// **bold**, *italics*, [links](url), ordered/unordered lists with indented
// continuation lines, blockquotes, and horizontal rules.

import { RECOVERY_GUIDE_MD } from './recovery-guide';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline formatting for one line of text (code spans, bold, italics, links). */
function inline(text: string): string {
  const parts = text.split(/(`[^`]+`)/);
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      let s = escapeHtml(part);
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      return s;
    })
    .join('');
}

function tableCells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** Convert the guide markdown to HTML block elements. */
function mdToHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  let codeIndent = 0;
  let codeBuf: string[] = [];
  let ol = 0; // current ordered number (0 = not in an ordered list)
  let ul = false; // in an unordered list
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length) {
      out.push(`<p>${inline(para.map((l) => l.trim()).join(' '))}</p>`);
      para = [];
    }
  };
  const endLists = (): void => {
    ol = 0;
    ul = false;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const stripped = line.trim();

    // fenced code block toggle (may be indented as list continuation)
    const openFence = /^(\s*)```(\w*)\s*$/.exec(line);
    if (openFence && !inCode) {
      flushPara();
      inCode = true;
      codeIndent = openFence[1]!.length;
      codeBuf = [];
      continue;
    }
    if (inCode) {
      if (/^\s*```\s*$/.test(line)) {
        const cls = ol || ul ? ' class="cont-code"' : '';
        out.push(`<pre${cls}><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`);
        inCode = false;
      } else {
        codeBuf.push(line.length >= codeIndent ? line.slice(codeIndent) : line);
      }
      continue;
    }

    // table
    if (stripped.startsWith('|')) {
      flushPara();
      endLists();
      const rows: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push((lines[i] ?? '').trim());
        i += 1;
      }
      i -= 1;
      out.push('<table>');
      if (rows.length) {
        out.push(
          `<thead><tr>${tableCells(rows[0]!)
            .map((c) => `<th>${inline(c)}</th>`)
            .join('')}</tr></thead>`,
        );
        // rows[1] is the |---|---| separator when present
        const sepIsRule = rows.length > 1 && /^[|\s:-]+$/.test(rows[1] ?? '');
        const body = sepIsRule ? rows.slice(2) : rows.slice(1);
        out.push('<tbody>');
        for (const r of body) {
          out.push(
            `<tr>${tableCells(r)
              .map((c) => `<td>${inline(c)}</td>`)
              .join('')}</tr>`,
          );
        }
        out.push('</tbody>');
      }
      out.push('</table>');
      continue;
    }

    // header
    const header = /^(#{1,3})\s+(.*)$/.exec(line);
    if (header) {
      flushPara();
      endLists();
      const lvl = header[1]!.length;
      out.push(`<h${lvl}>${inline(header[2]!)}</h${lvl}>`);
      continue;
    }

    // horizontal rule
    if (/^---+\s*$/.test(line)) {
      flushPara();
      endLists();
      out.push('<hr>');
      continue;
    }

    // blockquote (single-line, as the guide uses)
    if (stripped.startsWith('> ')) {
      flushPara();
      out.push(`<blockquote>${inline(stripped.slice(2))}</blockquote>`);
      continue;
    }

    // ordered list item
    const oli = /^(\s*)(\d+)\.\s+(.*)$/.exec(line);
    if (oli) {
      flushPara();
      ol = Number(oli[2]);
      ul = false;
      out.push(
        `<div class="li"><span class="num">${ol}.</span><span class="lit">${inline(
          oli[3]!,
        )}</span></div>`,
      );
      continue;
    }

    // unordered list item
    const uli = /^(\s*)-\s+(.*)$/.exec(line);
    if (uli) {
      flushPara();
      const indent = uli[1]!.length;
      ul = true;
      const cls = indent >= 2 ? 'li sub' : 'li';
      out.push(
        `<div class="${cls}"><span class="bul">&bull;</span><span class="lit">${inline(
          uli[2]!,
        )}</span></div>`,
      );
      continue;
    }

    // blank line
    if (stripped === '') {
      flushPara();
      continue;
    }

    // indented continuation of a list item
    if ((ol || ul) && /^\s{2,}\S/.test(line)) {
      out.push(`<div class="cont">${inline(stripped)}</div>`);
      continue;
    }

    // plain paragraph text
    endLists();
    para.push(line);
  }
  flushPara();
  return out.join('\n');
}

const PACKET_CSS = `
@page { size: letter; margin: 0.7in; }
* { box-sizing: border-box; }
body { font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #1a1a1a; font-size: 11pt; line-height: 1.5; }
.kit { page-break-after: always; }
.kit .banner { font-family: sans-serif; font-size: 9pt; letter-spacing:.5px; text-transform:uppercase; color:#8a1f1f; border:2px solid #8a1f1f; padding:6px 10px; margin-bottom:14px; text-align:center; font-weight:700; }
.kit pre { font-family: 'DejaVu Sans Mono', 'Courier New', monospace; font-size: 10.5pt; line-height: 1.45; white-space: pre-wrap; border:1px solid #ccc; padding:14px; border-radius:4px; }
h1 { font-size: 20pt; border-bottom: 3px solid #2a4d7a; padding-bottom:6px; margin:0 0 4px; }
h2 { font-size: 14.5pt; color:#2a4d7a; margin:22px 0 8px; border-bottom:1px solid #d0d7e2; padding-bottom:4px; page-break-after: avoid; }
h3 { font-size: 12pt; color:#333; margin:16px 0 6px; page-break-after: avoid; }
p { margin: 8px 0; }
a { color:#2a4d7a; text-decoration:none; }
hr { border:none; border-top:1px solid #d0d7e2; margin:18px 0; }
table { border-collapse: collapse; width:100%; margin:12px 0; font-size:10pt; page-break-inside: avoid; }
th, td { border:1px solid #c4ccd8; padding:7px 9px; text-align:left; vertical-align:top; }
th { background:#eef2f7; font-weight:700; }
tbody tr:nth-child(even) { background:#f7f9fb; }
code { font-family:'DejaVu Sans Mono','Courier New',monospace; font-size:9.7pt; background:#eef0f2; padding:1px 4px; border-radius:3px; }
pre { background:#f4f6f8; border:1px solid #d5dae0; border-left:3px solid #2a4d7a; border-radius:4px; padding:10px 12px; margin:10px 0; white-space:pre-wrap; word-break:break-word; page-break-inside: avoid; }
pre code { background:none; padding:0; font-size:9.5pt; }
pre.cont-code { margin-left:26px; }
blockquote { border-left:3px solid #c9a227; background:#fbf7e9; margin:10px 0; padding:8px 14px; }
.li { display:flex; gap:7px; margin:5px 0; }
.li.sub { margin-left:22px; }
.num, .bul { flex:0 0 auto; min-width:18px; font-weight:700; color:#2a4d7a; }
.lit { flex:1; }
.cont { margin:3px 0 3px 25px; }
`;

/**
 * Compose the full Recovery Packet: page 1 is the operator's kit sheet (all
 * secrets, verbatim monospace), followed by the recovery guide.
 */
export function composeRecoveryPacketHtml(kitText: string): string {
  const guide = mdToHtml(RECOVERY_GUIDE_MD);
  return (
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    PACKET_CSS +
    '</style></head><body>' +
    '<div class="kit"><div class="banner">Confidential — Practice System Recovery Packet — keep in a safe</div>' +
    `<pre>${escapeHtml(kitText)}</pre></div>` +
    guide +
    '</body></html>'
  );
}
