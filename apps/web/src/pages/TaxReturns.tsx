// SPDX-License-Identifier: Elastic-2.0
//
// Top-level Tax page. Hosts two tabs:
//   - Returns   — every parsed tax return for the firm
//   - Payments  — every scheduled tax payment for the firm,
//                 sortable / per-column filterable, with a multi-
//                 select bulk reminder action (email + SMS).
//
// Mounted at /tax/returns to preserve the existing nav entry and
// route. The tab key is kept in URL state via ?tab= so deep links
// resolve directly to the right view.

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { Tabs, tokens } from '@vibe/ui';

import { TaxPaymentsTab } from './tax/TaxPaymentsTab';
import { TaxReturnsTab } from './tax/TaxReturnsTab';
import { TaxSignatureCompletionsTab } from './tax/TaxSignatureCompletionsTab';

type Tab = 'returns' | 'signatures' | 'payments';

export function TaxReturnsStaffPage(): JSX.Element {
  const [search, setSearch] = useSearchParams();
  const tabParam = search.get('tab') as Tab;
  const initial: Tab =
    tabParam === 'payments' ? 'payments' : tabParam === 'signatures' ? 'signatures' : 'returns';
  const [tab, setTab] = useState<Tab>(initial);

  useEffect(() => {
    const next = new URLSearchParams(search);
    if (tab === 'returns') next.delete('tab');
    else next.set('tab', tab);
    setSearch(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <Tabs
        tabs={[
          { key: 'returns', label: 'Returns' },
          { key: 'signatures', label: 'Signatures' },
          { key: 'payments', label: 'Payments' },
        ]}
        active={tab}
        onChange={(k) => setTab(k as Tab)}
      />
      {tab === 'returns' && <TaxReturnsTab />}
      {tab === 'signatures' && <TaxSignatureCompletionsTab />}
      {tab === 'payments' && <TaxPaymentsTab />}
    </div>
  );
}
