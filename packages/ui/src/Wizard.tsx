// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Multi-step modal with a left-side stepper. Pattern matches the Canopy
// Create-Client wizard the user requested as the v2 bar: tabs on the
// left, content on the right, two sticky CTAs at top-right
// (primary action + secondary action). Each step is a freeform ReactNode
// so callers can lay out fields however they like.
//
// Visibility, current step, and form values are all owned by the caller.
// This component is purely structural — it has no opinion about
// validation, persistence, or step ordering.

import type { ReactNode } from 'react';

import { Button } from './Button';
import { tokens } from './tokens';
import { useIsNarrow } from './useIsNarrow';

export interface WizardStep {
  key: string;
  label: string;
  content: ReactNode;
}

export interface WizardProps {
  open: boolean;
  title: string;
  steps: WizardStep[];
  currentStepKey: string;
  onStepChange: (key: string) => void;
  onClose: () => void;
  primaryAction: { label: string; onClick: () => void; disabled?: boolean };
  secondaryAction?: { label: string; onClick: () => void; disabled?: boolean };
  headerExtras?: ReactNode;
  width?: number;
}

export function Wizard({
  open,
  title,
  steps,
  currentStepKey,
  onStepChange,
  onClose,
  primaryAction,
  secondaryAction,
  headerExtras,
  width = 1100,
}: WizardProps): JSX.Element | null {
  // M0 — phones: full-screen, steps as a horizontal strip, CTAs in a
  // sticky bottom bar (thumb reach). `width` is a desktop bound only.
  const narrow = useIsNarrow();
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: narrow ? 0 : '5vh 16px',
        background: 'rgba(0, 0, 0, 0.55)',
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'default',
        }}
      />
      <div
        style={{
          position: 'relative',
          background: tokens.color.surface,
          color: tokens.color.text,
          width: '100%',
          maxWidth: narrow ? '100dvw' : width,
          borderRadius: narrow ? 0 : tokens.radius.lg,
          border: narrow ? 'none' : `1px solid ${tokens.color.border}`,
          boxShadow: '0 24px 60px rgba(0,0,0,0.35)',
          display: 'flex',
          flexDirection: 'column',
          height: narrow ? '100dvh' : undefined,
          maxHeight: narrow ? '100dvh' : '90vh',
          paddingTop: narrow ? 'env(safe-area-inset-top, 0px)' : undefined,
        }}
      >
        <header
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: tokens.space.md,
            padding: `${tokens.space.md}px ${tokens.space.xl}px`,
            borderBottom: `1px solid ${tokens.color.border}`,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</h2>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {headerExtras}
            {!narrow && secondaryAction && (
              <Button
                variant="secondary"
                onClick={secondaryAction.onClick}
                disabled={secondaryAction.disabled}
              >
                {secondaryAction.label}
              </Button>
            )}
            {!narrow && (
              <Button onClick={primaryAction.onClick} disabled={primaryAction.disabled}>
                {primaryAction.label}
              </Button>
            )}
            <button
              type="button"
              aria-label="Close wizard"
              onClick={onClose}
              style={{
                marginLeft: 4,
                fontSize: 20,
                lineHeight: 1,
                width: 32,
                height: 32,
                borderRadius: tokens.radius.sm,
                background: 'transparent',
                border: `1px solid ${tokens.color.border}`,
                color: tokens.color.text,
                cursor: 'pointer',
              }}
            >
              ×
            </button>
          </div>
        </header>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: narrow ? '1fr' : '200px 1fr',
            gridTemplateRows: narrow ? 'auto 1fr' : undefined,
            gap: 0,
            flex: 1,
            minHeight: 0,
          }}
        >
          <nav
            aria-label="Wizard steps"
            style={
              narrow
                ? {
                    borderBottom: `1px solid ${tokens.color.border}`,
                    padding: `${tokens.space.sm}px ${tokens.space.md}px`,
                    display: 'flex',
                    flexDirection: 'row',
                    gap: 4,
                    overflowX: 'auto',
                    WebkitOverflowScrolling: 'touch',
                  }
                : {
                    borderRight: `1px solid ${tokens.color.border}`,
                    padding: tokens.space.md,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    overflowY: 'auto',
                  }
            }
          >
            {steps.map((step) => {
              const active = step.key === currentStepKey;
              return (
                <button
                  key={step.key}
                  type="button"
                  onClick={() => onStepChange(step.key)}
                  aria-current={active ? 'step' : undefined}
                  style={{
                    textAlign: 'left',
                    fontSize: 13,
                    padding: '8px 10px',
                    borderRadius: tokens.radius.sm,
                    background: active ? tokens.color.accentMuted : 'transparent',
                    color: active ? tokens.color.accent : tokens.color.text,
                    border: 'none',
                    cursor: 'pointer',
                    fontWeight: active ? 600 : 400,
                    flexShrink: narrow ? 0 : undefined,
                    whiteSpace: narrow ? 'nowrap' : undefined,
                  }}
                >
                  {step.label}
                </button>
              );
            })}
          </nav>
          <section
            style={{
              padding: narrow ? tokens.space.md : tokens.space.xl,
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
            }}
          >
            {steps.find((s) => s.key === currentStepKey)?.content ?? null}
          </section>
        </div>

        {narrow && (
          <footer
            style={{
              display: 'flex',
              gap: tokens.space.sm,
              padding: tokens.space.md,
              paddingBottom: `calc(${tokens.space.md}px + env(safe-area-inset-bottom, 0px))`,
              borderTop: `1px solid ${tokens.color.border}`,
              flexShrink: 0,
              background: tokens.color.surface,
            }}
          >
            {secondaryAction && (
              <div style={{ flex: 1, display: 'flex' }}>
                <Button
                  variant="secondary"
                  onClick={secondaryAction.onClick}
                  disabled={secondaryAction.disabled}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  {secondaryAction.label}
                </Button>
              </div>
            )}
            <div style={{ flex: 1, display: 'flex' }}>
              <Button
                onClick={primaryAction.onClick}
                disabled={primaryAction.disabled}
                style={{ width: '100%', justifyContent: 'center' }}
              >
                {primaryAction.label}
              </Button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
