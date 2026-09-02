// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — US 10DLC registration banner. Shown on the inbox and on the SMS
// settings page until the firm's Messaging Service carries a VERIFIED
// campaign; sends to US long codes are blocked meanwhile (D10 / Phase 10).

import { Pill, tokens } from '@vibe/ui';

import type { SmsA2pStatus } from './types';

export function A2pBanner({
  status,
  configured,
  showAdminLink,
  onDismiss,
}: {
  status: SmsA2pStatus | undefined;
  configured: boolean;
  showAdminLink: boolean;
  onDismiss?: () => void;
}): JSX.Element | null {
  if (!configured || !status || status === 'registered' || status === 'not_applicable') return null;
  const tone = status === 'pending' ? 'warning' : status === 'unregistered' ? 'danger' : 'neutral';
  const label =
    status === 'pending'
      ? 'pending'
      : status === 'unregistered'
        ? 'not registered'
        : 'not yet checked';
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        gap: 12,
        alignItems: 'center',
        flexWrap: 'wrap',
        padding: '10px 12px',
        border: `1px solid ${tokens.color.border}`,
        borderLeft: `4px solid ${status === 'unregistered' ? tokens.color.danger : tokens.color.warning}`,
        borderRadius: tokens.radius.md,
        background: tokens.color.surface,
        fontSize: 13,
      }}
    >
      <Pill tone={tone}>10DLC {label}</Pill>
      <span style={{ flex: 1, minWidth: 240 }}>
        US A2P 10DLC registration is {label}. Texts to US long-code numbers are blocked until Brand
        + Campaign registration completes in the Twilio console.
      </span>
      {showAdminLink && (
        <a href="/admin/sms-inbox" style={{ fontSize: 12, color: tokens.color.accent }}>
          SMS inbox settings →
        </a>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          style={{
            background: 'transparent',
            border: 'none',
            color: tokens.color.textMuted,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Dismiss
        </button>
      )}
    </div>
  );
}
