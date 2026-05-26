// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 — suggested-query chips under the search input.

import { tokens } from '@vibe/ui';

export function SuggestionChips({
  queries,
  onPick,
}: {
  queries: string[];
  onPick: (q: string) => void;
}): JSX.Element | null {
  if (queries.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {queries.map((q) => (
        <button
          key={q}
          type="button"
          onClick={() => onPick(q)}
          style={{
            background: tokens.color.bg,
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.pill,
            padding: '4px 10px',
            fontSize: 12,
            color: tokens.color.text,
            cursor: 'pointer',
          }}
        >
          {q}
        </button>
      ))}
    </div>
  );
}
