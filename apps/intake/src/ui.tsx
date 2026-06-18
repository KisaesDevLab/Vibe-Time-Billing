// SPDX-License-Identifier: Elastic-2.0
//
// Shared design language for the public intake surface (Send Documents +
// public booking). Ported from the "VCPA intake form redesign" Claude Design
// artifact: Space Grotesk headings + Manrope body, a #0f6cbd accent on a soft
// light background, rounded cards, a step indicator, and trust affordances.
// These pages are anonymous and self-contained, so the palette is hard-coded
// here rather than driven by the app token theme.

import type { CSSProperties, ReactNode } from 'react';

export const palette = {
  accent: '#0f6cbd',
  accentSoft: '#eef4fd',
  accentSoft2: '#e3edf9',
  pageBg: '#f4f6fb',
  pageGradient:
    'radial-gradient(1100px 560px at 72% -10%, rgba(15,108,189,0.07), transparent 60%), #f4f6fb',
  card: '#ffffff',
  ink: '#16203a',
  inkBody: '#18233b',
  text: '#3a4663',
  muted: '#5b6678',
  muted2: '#8a94a6',
  faint: '#94a0b3',
  faint2: '#a4afc0',
  border: '#e6eaf1',
  borderStrong: '#d4dbe6',
  success: '#0f9d6b',
  successBg: '#e3f5ec',
  successBorder: '#c7ecd9',
  successInk: '#0a7a52',
  danger: '#e5484d',
  dangerBg: '#fdeceb',
} as const;

export const headFont = "'Space Grotesk', system-ui, sans-serif";
export const bodyFont = "'Manrope', system-ui, sans-serif";

export const cardShadow = '0 1px 2px rgba(16,24,40,0.04)';

// ---- style helpers ----------------------------------------------------

export const cardStyle: CSSProperties = {
  background: palette.card,
  border: `1px solid ${palette.border}`,
  borderRadius: 20,
  padding: 'clamp(20px, 4vw, 32px)',
  boxShadow: '0 18px 50px -30px rgba(16,30,60,0.35)',
};

export function fieldStyle(error = false): CSSProperties {
  return {
    width: '100%',
    boxSizing: 'border-box',
    background: '#fff',
    border: `1px solid ${error ? palette.danger : palette.borderStrong}`,
    borderRadius: 12,
    padding: '13px 16px',
    color: palette.ink,
    fontSize: 16,
    fontFamily: 'inherit',
    outline: 'none',
  };
}

export const fieldLabelStyle: CSSProperties = {
  fontSize: 13.5,
  fontWeight: 600,
  color: palette.text,
};

export function primaryButtonStyle(enabled: boolean): CSSProperties {
  return {
    height: 54,
    padding: '0 22px',
    border: 'none',
    borderRadius: 14,
    fontFamily: headFont,
    fontWeight: 600,
    fontSize: 16,
    cursor: enabled ? 'pointer' : 'not-allowed',
    background: enabled ? palette.accent : '#e6eaf1',
    color: enabled ? '#fff' : palette.faint2,
    boxShadow: enabled ? '0 6px 18px -8px rgba(15,108,189,0.6)' : 'none',
    transition: 'background .15s, box-shadow .15s',
  };
}

export const ghostButtonStyle: CSSProperties = {
  height: 54,
  padding: '0 22px',
  borderRadius: 14,
  border: `1px solid ${palette.borderStrong}`,
  background: '#fff',
  color: palette.text,
  fontFamily: headFont,
  fontWeight: 600,
  fontSize: 16,
  cursor: 'pointer',
};

export function headingStyle(): CSSProperties {
  return {
    margin: '0 0 6px',
    fontFamily: headFont,
    fontWeight: 600,
    fontSize: 'clamp(23px, 3.2vw, 30px)',
    letterSpacing: '-0.01em',
    color: palette.ink,
  };
}

export const subheadStyle: CSSProperties = { margin: 0, color: palette.muted, fontSize: 16 };

// ---- shared components ------------------------------------------------

// Small "Encrypted & secure" reassurance pill used in page headers.
export function SecureBadge(): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        background: palette.successBg,
        border: `1px solid ${palette.successBorder}`,
        borderRadius: 999,
        padding: '6px 13px',
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: palette.success,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
        }}
      >
        <Check size={9} stroke="#fff" />
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color: palette.successInk }}>
        Encrypted &amp; secure
      </span>
    </div>
  );
}

// Firm wordmark (logo monogram + name) used at the top of intake/booking.
export function BrandHeader({ firmName = 'Your firm' }: { firmName?: string }): JSX.Element {
  const initial = firmName.trim().charAt(0).toUpperCase() || 'V';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 12,
          background: palette.accent,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: headFont,
          fontWeight: 700,
          fontSize: 19,
          color: '#fff',
        }}
      >
        {initial}
      </div>
      <div style={{ fontFamily: headFont, fontWeight: 600, fontSize: 16, color: palette.ink }}>
        {firmName}
      </div>
    </div>
  );
}

export interface Step {
  n: number;
  label: string;
}

// Horizontal step indicator. `current` is 1-based; steps below it render done.
export function Stepper({ steps, current }: { steps: Step[]; current: number }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'center', overflowX: 'auto', paddingBottom: 4 }}>
      {steps.map((s, i) => {
        const done = current > s.n;
        const active = current === s.n;
        const dotBase: CSSProperties = {
          width: 30,
          height: 30,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: headFont,
          fontWeight: 700,
          fontSize: 14,
          flex: 'none',
        };
        const dot: CSSProperties = done
          ? { ...dotBase, background: palette.accent, color: '#fff' }
          : active
            ? {
                ...dotBase,
                background: '#fff',
                border: `2px solid ${palette.accent}`,
                color: palette.accent,
              }
            : {
                ...dotBase,
                background: '#fff',
                border: `1px solid ${palette.borderStrong}`,
                color: palette.faint2,
              };
        return (
          <div key={s.n} style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
            {i > 0 && (
              <div
                style={{
                  flex: 1,
                  minWidth: 14,
                  height: 2,
                  margin: '0 10px',
                  borderRadius: 2,
                  background: current >= s.n ? palette.accent : '#dce2ec',
                }}
              />
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <div style={dot}>{done ? <Check size={14} stroke="#fff" /> : s.n}</div>
              <span
                style={{
                  fontFamily: headFont,
                  fontWeight: 600,
                  fontSize: 14,
                  whiteSpace: 'nowrap',
                  color: active ? palette.ink : done ? palette.muted : palette.faint2,
                }}
              >
                {s.label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const TRUST = [
  'Encrypted in transit & at rest',
  'Scanned before anyone sees them',
  'We never share your files',
];

export function TrustFooter(): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px 22px',
        marginTop: 8,
        paddingTop: 18,
        borderTop: `1px solid ${palette.border}`,
      }}
    >
      {TRUST.map((t) => (
        <div
          key={t}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: palette.muted,
          }}
        >
          <span
            style={{
              width: 17,
              height: 17,
              borderRadius: '50%',
              background: palette.successBg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 'none',
            }}
          >
            <Check size={9} stroke={palette.success} />
          </span>
          {t}
        </div>
      ))}
    </div>
  );
}

// ---- inline icons -----------------------------------------------------

export function Check({
  size = 12,
  stroke = '#fff',
}: {
  size?: number;
  stroke?: string;
}): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden>
      <polyline
        points="2,6.5 5,9 10,3"
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function infoNote(text: ReactNode, danger = false): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 9,
        color: palette.muted,
        fontSize: 13,
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: danger ? palette.dangerBg : palette.accentSoft,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flex: 'none',
          marginTop: 1,
          color: danger ? palette.danger : palette.accent,
          fontWeight: 700,
          fontSize: 12,
        }}
      >
        !
      </span>
      {text}
    </div>
  );
}
