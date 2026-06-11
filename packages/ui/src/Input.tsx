// SPDX-License-Identifier: Elastic-2.0
import type { InputHTMLAttributes } from 'react';

import { tokens } from './tokens';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  invalid?: boolean;
}

export function Input({ label, hint, invalid, id, style, ...rest }: InputProps): JSX.Element {
  const inputId = id ?? `input-${rest.name ?? Math.random().toString(36).slice(2)}`;
  const borderColor = invalid ? tokens.color.danger : tokens.color.border;
  return (
    <label htmlFor={inputId} style={{ display: 'block', fontFamily: tokens.font.body }}>
      {label && (
        <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>{label}</div>
      )}
      <input
        id={inputId}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '10px 12px',
          background: tokens.color.surface,
          color: tokens.color.text,
          border: `1px solid ${borderColor}`,
          borderRadius: tokens.radius.md,
          fontFamily: tokens.font.body,
          fontSize: 14,
          ...style,
        }}
        {...rest}
      />
      {hint && (
        <div
          style={{
            fontSize: 12,
            color: invalid ? tokens.color.danger : tokens.color.textMuted,
            marginTop: 4,
          }}
        >
          {hint}
        </div>
      )}
    </label>
  );
}
