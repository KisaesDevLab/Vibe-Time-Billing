// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { tokens } from './tokens';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  children: ReactNode;
}

const variantStyle = (variant: ButtonProps['variant']) => {
  switch (variant) {
    case 'danger':
      return { background: tokens.color.danger, color: '#fff', border: 'none' };
    case 'secondary':
      return {
        background: 'transparent',
        color: tokens.color.text,
        border: `1px solid ${tokens.color.border}`,
      };
    case 'ghost':
      return { background: 'transparent', color: tokens.color.text, border: 'none' };
    case 'primary':
    default:
      return { background: tokens.color.accent, color: '#fff', border: 'none' };
  }
};

export function Button({
  variant = 'primary',
  size = 'md',
  children,
  style,
  ...rest
}: ButtonProps): JSX.Element {
  const padding = size === 'sm' ? '6px 10px' : '10px 16px';
  const fontSize = size === 'sm' ? 12 : 14;
  return (
    <button
      type={rest.type ?? 'button'}
      style={{
        padding,
        fontSize,
        borderRadius: tokens.radius.md,
        fontFamily: tokens.font.body,
        fontWeight: 500,
        cursor: rest.disabled ? 'not-allowed' : 'pointer',
        opacity: rest.disabled ? 0.5 : 1,
        ...variantStyle(variant),
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}
