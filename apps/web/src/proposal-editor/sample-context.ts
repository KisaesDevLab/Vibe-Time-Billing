// SPDX-License-Identifier: Elastic-2.0
//
// PP4b / P05 — Stable sample merge-token context used by the
// firm-side preview pane. Real proposal acceptance (P21) substitutes
// the live firm/client/engagement values.

import type { MergeContext } from '@vibe/core/proposals';

export function sampleMergeContext(): MergeContext {
  return {
    client: {
      name: 'Acme Co',
      primary_email: 'cfo@acme.example',
      mailing_address: '123 Market St, Springfield IL 62701',
    },
    firm: {
      name: 'Smith CPAs',
      address: '456 State St, Capital City IL 62702',
      phone: '(555) 555-1212',
      email: 'hello@smithcpas.example',
    },
    engagement: {
      name: 'Annual Tax + Bookkeeping 2026',
      start_date: '2026-01-15',
      end_date: '2026-04-15',
      tax_year: 2026,
    },
    today: new Date().toISOString().slice(0, 10),
  };
}
