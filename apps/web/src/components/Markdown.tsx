// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Minimal, dependency-free markdown renderer for knowledge-base articles.
// Supports headings, paragraphs, unordered/ordered lists, blockquotes,
// fenced + inline code, bold, and links. Renders to React elements (no
// dangerouslySetInnerHTML), so there's no HTML-injection surface.

import { type ReactNode } from 'react';

import { tokens } from '@vibe/ui';

// Inline formatting: **bold**, `code`, [text](url). Splits the line into
// React nodes without injecting HTML.
function inline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Tokenize on the three inline constructs.
  const re = /(\*\*([^*]+)\*\*)|(`([^`]+)`)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[2] != null) {
      nodes.push(<strong key={key}>{m[2]}</strong>);
    } else if (m[4] != null) {
      nodes.push(
        <code
          key={key}
          style={{
            fontFamily: tokens.font.mono,
            fontSize: '0.9em',
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: 4,
            padding: '1px 4px',
          }}
        >
          {m[4]}
        </code>,
      );
    } else if (m[6] != null && m[7] != null) {
      nodes.push(
        <a
          key={key}
          href={m[7]}
          target="_blank"
          rel="noreferrer"
          style={{ color: tokens.color.accent }}
        >
          {m[6]}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ source }: { source: string }): JSX.Element {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      blocks.push(
        <pre
          key={key++}
          style={{
            fontFamily: tokens.font.mono,
            fontSize: 12.5,
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            padding: tokens.space.sm,
            overflowX: 'auto',
            margin: `${tokens.space.sm} 0`,
          }}
        >
          {buf.join('\n')}
        </pre>,
      );
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Headings
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      const sizes = [22, 18, 15, 14];
      blocks.push(
        <div
          key={key++}
          style={{
            fontSize: sizes[level - 1],
            fontWeight: 600,
            margin: level === 1 ? '4px 0 8px' : '14px 0 6px',
          }}
        >
          {inline(h[2]!, `h${key}`)}
        </div>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        buf.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      blocks.push(
        <blockquote
          key={key++}
          style={{
            borderLeft: `3px solid ${tokens.color.border}`,
            margin: `${tokens.space.sm} 0`,
            padding: `2px 0 2px ${tokens.space.sm}`,
            color: tokens.color.textMuted,
            fontSize: 13.5,
          }}
        >
          {inline(buf.join(' '), `bq${key}`)}
        </blockquote>,
      );
      continue;
    }

    // Lists (unordered - / *, ordered 1.)
    const isUl = /^\s*[-*]\s+/.test(line);
    const isOl = /^\s*\d+\.\s+/.test(line);
    if (isUl || isOl) {
      const items: ReactNode[] = [];
      const test = isUl ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/;
      let li = 0;
      while (i < lines.length && test.test(lines[i]!)) {
        const content = lines[i]!.replace(test, '');
        items.push(<li key={li++}>{inline(content, `li${key}-${li}`)}</li>);
        i++;
      }
      const listStyle = {
        margin: `${tokens.space.sm} 0`,
        paddingLeft: 22,
        fontSize: 13.5,
        lineHeight: 1.6,
      };
      blocks.push(
        isUl ? (
          <ul key={key++} style={listStyle}>
            {items}
          </ul>
        ) : (
          <ol key={key++} style={listStyle}>
            {items}
          </ol>
        ),
      );
      continue;
    }

    // Paragraph (join consecutive non-blank, non-special lines)
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(#{1,4})\s/.test(lines[i]!) &&
      !lines[i]!.startsWith('>') &&
      !/^\s*[-*]\s+/.test(lines[i]!) &&
      !/^\s*\d+\.\s+/.test(lines[i]!) &&
      !lines[i]!.trimStart().startsWith('```')
    ) {
      buf.push(lines[i]!);
      i++;
    }
    blocks.push(
      <p key={key++} style={{ margin: `${tokens.space.sm} 0`, fontSize: 13.5, lineHeight: 1.6 }}>
        {inline(buf.join(' '), `p${key}`)}
      </p>,
    );
  }

  return <div>{blocks}</div>;
}
