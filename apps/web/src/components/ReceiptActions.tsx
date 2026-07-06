// SPDX-License-Identifier: Elastic-2.0
//
// Print / email a payment receipt by receipt id. Shared by the
// Receive-payment success screen and the Payments-list receipt drawer so a
// staff member can produce a receipt for ANY payment (card, cash, check,
// ACH) both at capture time and after the fact. Email goes to the client's
// billing contact (falling back to primary).

import { useState } from 'react';

import { Button, tokens } from '@vibe/ui';

import { api } from '../api-client';
import { PrintButton } from './PrintButton';

export function ReceiptActions({ receiptId }: { receiptId: string }): JSX.Element {
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function emailReceipt(): Promise<void> {
    setSending(true);
    setMsg(null);
    try {
      const r = await api<{ to: string }>(`/api/staff/payments/receipt/${receiptId}/email`, {
        method: 'POST',
        body: '{}',
      });
      setMsg(`Emailed to ${r.to}.`);
    } catch (e) {
      const m = e instanceof Error ? e.message : 'failed';
      setMsg(
        m === 'no_billing_contact_email'
          ? 'No billing/primary contact with an email on file.'
          : m === 'mail_not_configured'
            ? 'Email delivery is not configured.'
            : `Email failed: ${m}`,
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => window.open(`/api/staff/payments/receipt/${receiptId}/print.html`, '_blank')}
      >
        Print receipt
      </Button>
      <PrintButton
        endpoint={`/api/staff/payments/receipt/${receiptId}/print`}
        label="Print to printer"
      />
      <Button size="sm" variant="secondary" disabled={sending} onClick={() => void emailReceipt()}>
        {sending ? 'Emailing…' : 'Email receipt'}
      </Button>
      {msg && <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{msg}</span>}
    </span>
  );
}
