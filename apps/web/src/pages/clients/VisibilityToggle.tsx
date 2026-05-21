// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Per-row Visible-in-portal toggle. Eye-with-check (visible) /
// eye-outline (hidden). UI-only effect for now — portal binding lands
// in a later workstream, but the flag persists.

import { tokens } from '@vibe/ui';

interface Props {
  visible: boolean;
  onToggle: () => void;
  disabled?: boolean;
  ariaLabel?: string;
}

export function VisibilityToggle({ visible, onToggle, disabled, ariaLabel }: Props): JSX.Element {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        if (!disabled) onToggle();
      }}
      disabled={disabled}
      aria-pressed={visible}
      aria-label={ariaLabel ?? (visible ? 'Visible in portal' : 'Not visible in portal')}
      title={visible ? 'Visible in portal' : 'Not visible — click to flip'}
      style={{
        background: 'none',
        border: 'none',
        padding: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        color: visible ? tokens.color.accent : tokens.color.textMuted,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: tokens.radius.sm,
      }}
    >
      {visible ? (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 5c-7 0-10 7-10 7s3 7 10 7 10-7 10-7-3-7-10-7z"
            stroke="currentColor"
            strokeWidth="1.5"
            fill="currentColor"
            fillOpacity="0.18"
          />
          <circle cx="12" cy="12" r="3" fill="currentColor" />
          <path
            d="M9 12l2 2 4-4"
            stroke="white"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M3 3l18 18M9.5 9.5a3 3 0 014.24 4.24M6 6.5C3.5 8.5 2 12 2 12s3 7 10 7c2 0 3.7-.6 5.1-1.5M11 5c.3 0 .6 0 1 0 7 0 10 7 10 7-.5 1-1.2 2.1-2.1 3.1"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
  );
}
