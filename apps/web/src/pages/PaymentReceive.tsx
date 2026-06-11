// SPDX-License-Identifier: Elastic-2.0
//
// Receive Payment (0055). Staff-facing page modeled on the QuickBooks
// receive-payment screen. Two modes:
//
//   - RECORD  — write payment rows directly. Used for checks, cash,
//               and ACH transfers received outside Stripe.
//   - CHARGE  — server creates a Stripe PaymentIntent; Stripe Elements
//               confirms client-side; the Stripe webhook materializes
//               the payment rows once Stripe reports success. The page
//               polls GET /payments/receive/:id until status leaves
//               PENDING (max ~20s, then prompts user to refresh later).
//
// Multi-entity: picking a primary payer auto-loads any other clients
// reachable from the same portal identity (the existing
// client_portal_access graph). Staff can add more entities via search.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import { loadStripe, type Stripe } from '@stripe/stripe-js';

import { Button, Card, Combobox, Input, Pill, Table, tokens, type ComboboxOption } from '@vibe/ui';

import { api } from '../api-client';

// ---------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------

type Mode = 'RECORD' | 'CHARGE' | 'TERMINAL';

interface TerminalReader {
  id: string;
  label: string;
  status: string;
}
// Loosened from a closed union in 0089 — paymentMethod is now an
// UPPER_SNAKE key sourced from /admin/payment-method-types. The two
// synthetic protocol values (CARD_STRIPE, CREDIT_APPLY) are kept
// inline because they aren't catalog rows; they're injected by the
// receive flow based on context.
type PaymentMethod = string;

interface PaymentConfig {
  stripeEnabled: boolean;
  stripePublishableKey: string | null;
  achEnabled: boolean;
  ccEnabled: boolean;
  cpaChargeEnabled: boolean;
}

interface ClientLite {
  id: string;
  name: string;
}

interface SuggestedClient {
  clientId: string;
  clientName: string;
  identityFullName: string | null;
}

interface OutstandingInvoice {
  id: string;
  invoiceNumber: string;
  clientId: string;
  clientName: string;
  issueDate: string | null;
  dueDate: string | null;
  totalCents: number;
  paidCents: number;
  openCents: number;
  status: string;
}

interface AllocationDraft {
  invoiceId: string;
  amountDollars: string;
  selected: boolean;
}

interface OpenCredit {
  id: string;
  clientId: string;
  clientName: string;
  issuedDate: string;
  originalAmountCents: number;
  remainingAmountCents: number;
  appliedCents: number;
  source: 'MANUAL' | 'OVERPAYMENT' | 'REFUND_EXCESS';
  reference: string | null;
  status: 'OPEN' | 'PARTIALLY_APPLIED' | 'FULLY_APPLIED' | 'VOIDED';
}

interface CreditAppDraft {
  creditMemoId: string;
  invoiceId: string;
  amountDollars: string;
  selected: boolean;
}

// ---------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------

function dollars(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function dollarsToCents(s: string): number {
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

function centsToDollarsInput(c: number): string {
  return (c / 100).toFixed(2);
}

// Fallback method list when the catalog endpoint is unreachable (no
// permission, dev seed missing, network glitch). Matches the four
// built-ins seeded by bootstrap-firm so the form always renders
// something usable.
const FALLBACK_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'CHECK', label: 'Check' },
  { value: 'CASH', label: 'Cash' },
  { value: 'ACH_MANUAL', label: 'ACH (manual)' },
  { value: 'OTHER', label: 'Other' },
];

// ---------------------------------------------------------------------
// Top-level page
// ---------------------------------------------------------------------

export function PaymentReceivePage(): JSX.Element {
  const [config, setConfig] = useState<PaymentConfig | null>(null);
  const [stripePromise, setStripePromise] = useState<Promise<Stripe | null> | null>(null);

  useEffect(() => {
    void (async () => {
      const r = await api<PaymentConfig>('/api/staff/payments/config');
      setConfig(r);
      if (r.stripeEnabled && r.stripePublishableKey) {
        setStripePromise(loadStripe(r.stripePublishableKey));
      }
    })();
  }, []);

  if (!config) {
    return (
      <Card title="Receive payment">
        <p style={{ color: tokens.color.textMuted, fontSize: 13 }}>Loading…</p>
      </Card>
    );
  }

  return <Inner config={config} stripePromise={stripePromise} />;
}

function Inner({
  config,
  stripePromise,
}: {
  config: PaymentConfig;
  stripePromise: Promise<Stripe | null> | null;
}): JSX.Element {
  const navigate = useNavigate();

  const [mode, setMode] = useState<Mode>('RECORD');
  const [paymentDate, setPaymentDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CHECK');
  const [amountDollars, setAmountDollars] = useState('');

  // Payer + included entities
  const [payerClientId, setPayerClientId] = useState<string>('');
  const [includedClientIds, setIncludedClientIds] = useState<string[]>([]); // additional entities beyond payer
  const [suggested, setSuggested] = useState<SuggestedClient[]>([]);
  const [allClients, setAllClients] = useState<ClientLite[]>([]); // preloaded for combobox label + filter

  // Outstanding invoices + allocation drafts
  const [outstanding, setOutstanding] = useState<OutstandingInvoice[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AllocationDraft>>({});

  // Open credits for the included clients + per-credit application drafts
  const [openCredits, setOpenCredits] = useState<OpenCredit[]>([]);
  const [creditDrafts, setCreditDrafts] = useState<Record<string, CreditAppDraft>>({});

  // Submission state
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // CHARGE flow state
  const [chargeReceipt, setChargeReceipt] = useState<{
    receiptId: string;
    clientSecret: string;
  } | null>(null);

  // Post-record state. `banner` = recorded via "Record + New" (form is reset
  // and a confirmation banner with receipt actions stays on top); otherwise
  // the success screen replaces the form.
  const [recorded, setRecorded] = useState<{
    receiptId: string;
    clientName: string;
    amountCents: number;
    banner: boolean;
  } | null>(null);

  // TERMINAL (in-person reader) flow state.
  const [readers, setReaders] = useState<TerminalReader[]>([]);
  const [readerId, setReaderId] = useState('');
  const [terminalPending, setTerminalPending] = useState<{
    receiptId: string;
    paymentIntentId: string;
  } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const terminalAvailable = config.stripeEnabled && readers.length > 0;

  // Cache the payer + any selected entities so the Combobox always has labels.
  const allSelectedIds = useMemo(
    () => (payerClientId ? [payerClientId, ...includedClientIds] : []),
    [payerClientId, includedClientIds],
  );

  // Initial client load — Combobox filters locally on type.
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{ items: ClientLite[] }>('/api/staff/clients?pageSize=200');
        setAllClients(r.items ?? []);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load clients');
      }
    })();
  }, []);

  // Terminal readers — only when Stripe is connected. Drives the in-person
  // "Terminal" mode (hidden when no readers are provisioned).
  useEffect(() => {
    if (!config.stripeEnabled) return;
    void api<{ readers: TerminalReader[] }>('/api/staff/terminal/readers')
      .then((r) => setReaders(r.readers ?? []))
      .catch(() => undefined);
  }, [config.stripeEnabled]);

  // Stop polling on unmount.
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );

  // 0089 — pull the firm's payment-method catalog. Falls back to the
  // four built-ins (CHECK/CASH/ACH_MANUAL/OTHER) if the endpoint is
  // unreachable so the form is never broken.
  const [methods, setMethods] =
    useState<{ value: PaymentMethod; label: string }[]>(FALLBACK_METHODS);
  useEffect(() => {
    void (async () => {
      try {
        const r = await api<{
          items: { key: string; label: string; active: boolean; displayOrder: number }[];
        }>('/api/staff/admin/payment-method-types');
        const active = (r.items ?? [])
          .filter((m) => m.active)
          .sort((a, b) => a.displayOrder - b.displayOrder)
          .map((m) => ({ value: m.key, label: m.label }));
        if (active.length > 0) {
          setMethods(active);
          // If the currently-selected method was deactivated/renamed
          // out of the catalog, snap back to the first active.
          if (!active.find((m) => m.value === paymentMethod)) {
            setPaymentMethod(active[0]!.value);
          }
        }
      } catch {
        // Keep the fallback list silently — every staff role has
        // taxonomy:read so failure here is very rare.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- When payer changes: load suggestions ----
  useEffect(() => {
    if (!payerClientId) {
      setSuggested([]);
      return;
    }
    void (async () => {
      try {
        const r = await api<{ items: SuggestedClient[] }>(
          `/api/staff/payments/suggested-entities?clientId=${encodeURIComponent(payerClientId)}`,
        );
        setSuggested(r.items ?? []);
      } catch {
        setSuggested([]);
      }
    })();
  }, [payerClientId]);

  // ---- Load outstanding invoices for the included client set ----
  useEffect(() => {
    if (allSelectedIds.length === 0) {
      setOutstanding([]);
      setDrafts({});
      return;
    }
    void (async () => {
      try {
        const q = allSelectedIds.map((id) => `clientIds=${encodeURIComponent(id)}`).join('&');
        const r = await api<{ items: OutstandingInvoice[] }>(
          `/api/staff/payments/outstanding?${q}`,
        );
        setOutstanding(r.items ?? []);
        setDrafts((prev) => {
          const next: Record<string, AllocationDraft> = {};
          for (const inv of r.items ?? []) {
            next[inv.id] = prev[inv.id] ?? {
              invoiceId: inv.id,
              amountDollars: '',
              selected: false,
            };
          }
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load outstanding invoices');
      }
    })();
  }, [allSelectedIds]);

  // ---- Load open credits for the included client set ----
  useEffect(() => {
    if (allSelectedIds.length === 0) {
      setOpenCredits([]);
      setCreditDrafts({});
      return;
    }
    void (async () => {
      try {
        const q =
          allSelectedIds.map((id) => `clientIds=${encodeURIComponent(id)}`).join('&') +
          '&status=OPEN&status=PARTIALLY_APPLIED';
        const r = await api<{ items: OpenCredit[] }>(`/api/staff/credits?${q}`);
        setOpenCredits(r.items ?? []);
        // Initialize drafts for any new credits; preserve existing.
        setCreditDrafts((prev) => {
          const next: Record<string, CreditAppDraft> = {};
          for (const c of r.items ?? []) {
            next[c.id] = prev[c.id] ?? {
              creditMemoId: c.id,
              invoiceId: '',
              amountDollars: '',
              selected: false,
            };
          }
          return next;
        });
      } catch {
        // Non-fatal — credits panel just hides.
        setOpenCredits([]);
      }
    })();
  }, [allSelectedIds]);

  function toggleInvoice(invId: string): void {
    setDrafts((prev) => {
      const cur = prev[invId];
      if (!cur) return prev;
      const inv = outstanding.find((o) => o.id === invId);
      if (!inv) return prev;
      const willSelect = !cur.selected;
      if (!willSelect) {
        return { ...prev, [invId]: { ...cur, selected: false, amountDollars: '' } };
      }
      // Auto-allocate: take remaining (amount entered minus already-allocated)
      // up to this invoice's open balance.
      const entered = dollarsToCents(amountDollars);
      const alreadyAllocated = Object.values(prev).reduce(
        (s, d) => (d.invoiceId === invId || !d.selected ? s : s + dollarsToCents(d.amountDollars)),
        0,
      );
      const remaining = Math.max(0, entered - alreadyAllocated);
      const apply = Math.min(remaining, inv.openCents);
      return {
        ...prev,
        [invId]: {
          ...cur,
          selected: true,
          amountDollars: apply > 0 ? centsToDollarsInput(apply) : '',
        },
      };
    });
  }

  function setAllocation(invId: string, value: string): void {
    setDrafts((prev) => ({
      ...prev,
      [invId]: {
        ...(prev[invId] ?? { invoiceId: invId, amountDollars: '', selected: true }),
        amountDollars: value,
        selected: true,
      },
    }));
  }

  // Spread the amount entered across the outstanding invoices, oldest
  // first (the list is returned oldest-first), filling each up to its open
  // balance. Selects the invoices that receive an allocation and clears the
  // rest, so the result is a clean from-scratch distribution.
  function autoAllocate(): void {
    let remaining = dollarsToCents(amountDollars);
    setDrafts((prev) => {
      const next = { ...prev };
      for (const inv of outstanding) {
        const cur = next[inv.id] ?? { invoiceId: inv.id, amountDollars: '', selected: false };
        const take = Math.min(Math.max(0, remaining), inv.openCents);
        remaining -= take;
        next[inv.id] =
          take > 0
            ? { ...cur, selected: true, amountDollars: centsToDollarsInput(take) }
            : { ...cur, selected: false, amountDollars: '' };
      }
      return next;
    });
  }

  function addEntity(id: string): void {
    if (!id || id === payerClientId || includedClientIds.includes(id)) return;
    setIncludedClientIds((prev) => [...prev, id]);
  }

  function removeEntity(id: string): void {
    setIncludedClientIds((prev) => prev.filter((x) => x !== id));
  }

  function totalAllocatedCents(): number {
    return Object.values(drafts).reduce(
      (s, d) => (d.selected ? s + dollarsToCents(d.amountDollars) : s),
      0,
    );
  }

  function totalCreditAppliedCents(): number {
    return Object.values(creditDrafts).reduce(
      (s, c) => (c.selected && c.invoiceId ? s + dollarsToCents(c.amountDollars) : s),
      0,
    );
  }

  function toggleCredit(memoId: string): void {
    setCreditDrafts((prev) => {
      const cur = prev[memoId];
      if (!cur) return prev;
      const willSelect = !cur.selected;
      if (!willSelect) {
        return { ...prev, [memoId]: { ...cur, selected: false, invoiceId: '', amountDollars: '' } };
      }
      return { ...prev, [memoId]: { ...cur, selected: true } };
    });
  }

  function setCreditField(memoId: string, change: Partial<CreditAppDraft>): void {
    setCreditDrafts((prev) => ({
      ...prev,
      [memoId]: {
        ...(prev[memoId] ?? {
          creditMemoId: memoId,
          invoiceId: '',
          amountDollars: '',
          selected: true,
        }),
        ...change,
        selected: true,
      },
    }));
  }

  // Invoices currently selected in the Outstanding Transactions table —
  // the only valid targets for a credit application.
  const selectableInvoices = useMemo(
    () =>
      outstanding
        .filter((inv) => drafts[inv.id]?.selected)
        .map((inv) => ({
          value: inv.id,
          label: `#${inv.invoiceNumber}${inv.clientName ? ` · ${inv.clientName}` : ''}`,
        })),
    [outstanding, drafts],
  );

  type ValidationOk = {
    ok: true;
    allocations: { invoiceId: string; amountCents: number }[];
    creditApplications: { creditMemoId: string; invoiceId: string; amountCents: number }[];
    paymentMethodToSend: PaymentMethod | 'CREDIT_APPLY';
    amountCentsToSend: number;
  };
  type ValidationErr = { ok: false; reason: string };

  function validate(allowOverpayment: boolean): ValidationOk | ValidationErr {
    if (!payerClientId) return { ok: false, reason: 'Pick a payer.' };
    const entered = dollarsToCents(amountDollars);
    const allocations = Object.values(drafts)
      .filter((d) => d.selected)
      .map((d) => ({ invoiceId: d.invoiceId, amountCents: dollarsToCents(d.amountDollars) }))
      .filter((a) => a.amountCents > 0);
    const creditApplications = Object.values(creditDrafts)
      .filter((c) => c.selected && c.invoiceId && dollarsToCents(c.amountDollars) > 0)
      .map((c) => ({
        creditMemoId: c.creditMemoId,
        invoiceId: c.invoiceId,
        amountCents: dollarsToCents(c.amountDollars),
      }));
    const sumAlloc = allocations.reduce((s, a) => s + a.amountCents, 0);
    const isPureCreditApply = entered === 0;

    if (isPureCreditApply) {
      if (allocations.length > 0) {
        return {
          ok: false,
          reason: 'Amount received is 0 — uncheck the invoices to use credits only.',
        };
      }
      if (creditApplications.length === 0) {
        return { ok: false, reason: 'Select at least one credit or enter an amount received.' };
      }
      return {
        ok: true,
        allocations: [],
        creditApplications,
        paymentMethodToSend: 'CREDIT_APPLY',
        amountCentsToSend: 0,
      };
    }
    if (allocations.length === 0 && creditApplications.length === 0) {
      return { ok: false, reason: 'Select at least one invoice.' };
    }
    if (sumAlloc > entered) {
      return {
        ok: false,
        reason: `Allocated ${dollars(sumAlloc)} exceeds amount received ${dollars(entered)}.`,
      };
    }
    if (sumAlloc < entered && !allowOverpayment) {
      return {
        ok: false,
        reason: `Allocated ${dollars(sumAlloc)} is less than amount received ${dollars(entered)}. Add the surplus as a credit (auto) or fix the allocation.`,
      };
    }
    // Verify each invoice's (alloc + sum of credits) does not exceed open balance.
    const totalByInvoice = new Map<string, number>();
    for (const a of allocations) {
      totalByInvoice.set(a.invoiceId, (totalByInvoice.get(a.invoiceId) ?? 0) + a.amountCents);
    }
    for (const c of creditApplications) {
      totalByInvoice.set(c.invoiceId, (totalByInvoice.get(c.invoiceId) ?? 0) + c.amountCents);
    }
    for (const [invId, total] of totalByInvoice) {
      const inv = outstanding.find((o) => o.id === invId);
      if (inv && total > inv.openCents) {
        return {
          ok: false,
          reason: `Invoice #${inv.invoiceNumber}: ${dollars(total)} exceeds open balance ${dollars(inv.openCents)}.`,
        };
      }
    }
    return {
      ok: true,
      allocations,
      creditApplications,
      paymentMethodToSend: paymentMethod,
      amountCentsToSend: entered,
    };
  }

  // Clear the form for a fresh payment (used by "Record + New" and the
  // "Record another payment" success action).
  function resetForm(): void {
    setPayerClientId('');
    setIncludedClientIds([]);
    setOutstanding([]);
    setDrafts({});
    setOpenCredits([]);
    setCreditDrafts({});
    setAmountDollars('');
    setReference('');
    setChargeReceipt(null);
    setError(null);
  }

  const payerName = (): string =>
    allClients.find((c) => c.id === payerClientId)?.name ?? 'the client';

  async function submitRecord(thenNew: boolean): Promise<void> {
    setError(null);
    const v = validate(true /* allow overpayment → server creates credit */);
    if (!v.ok) {
      setError(v.reason);
      return;
    }
    setBusy(true);
    try {
      const r = await api<{
        receiptId: string;
        createdCredit: { id: string; amountCents: number } | null;
      }>('/api/staff/payments/receive', {
        method: 'POST',
        body: JSON.stringify({
          payerClientId,
          paymentDate,
          reference: reference.trim() || null,
          paymentMethod: v.paymentMethodToSend,
          amountReceivedCents: v.amountCentsToSend,
          allocations: v.allocations,
          creditApplications: v.creditApplications,
        }),
      });
      const success = {
        receiptId: r.receiptId,
        clientName: payerName(),
        amountCents: v.amountCentsToSend,
      };
      if (thenNew) {
        resetForm();
        setRecorded({ ...success, banner: true });
      } else {
        setRecorded({ ...success, banner: false });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'submit_failed');
    } finally {
      setBusy(false);
    }
  }

  async function startCharge(): Promise<void> {
    setError(null);
    // CHARGE mode never accepts credit applications (would be confusing
    // alongside a card auth). And the server-side intent endpoint still
    // enforces sum(allocations) === amountReceivedCents.
    const v = validate(false);
    if (!v.ok) {
      setError(v.reason);
      return;
    }
    if (v.creditApplications.length > 0) {
      setError('Credit applications are only available in Record mode.');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ receiptId: string; clientSecret: string }>(
        '/api/staff/payments/receive/intent',
        {
          method: 'POST',
          body: JSON.stringify({
            payerClientId,
            paymentDate,
            reference: reference.trim() || null,
            paymentMethod: 'CARD_STRIPE',
            amountReceivedCents: dollarsToCents(amountDollars),
            allocations: v.allocations,
          }),
        },
      );
      setChargeReceipt({ receiptId: r.receiptId, clientSecret: r.clientSecret });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'intent_failed');
    } finally {
      setBusy(false);
    }
  }

  // ---- TERMINAL (in-person reader) ----
  function pollReceipt(receiptId: string): void {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      void api<{ receipt: { status: string } | null }>(`/api/staff/payments/receive/${receiptId}`)
        .then((r) => {
          const status = r.receipt?.status;
          if (!status || status === 'PENDING') return;
          if (pollRef.current) clearInterval(pollRef.current);
          if (status === 'SUCCEEDED') {
            setRecorded({
              receiptId,
              clientName: payerName(),
              amountCents: dollarsToCents(amountDollars),
              banner: false,
            });
          } else {
            setError('The card was declined or cancelled on the reader.');
          }
          setTerminalPending(null);
        })
        .catch(() => undefined);
    }, 2500);
  }

  async function startTerminal(): Promise<void> {
    setError(null);
    const v = validate(false);
    if (!v.ok) {
      setError(v.reason);
      return;
    }
    if (v.creditApplications.length > 0) {
      setError('Credit applications are only available in Record mode.');
      return;
    }
    if (!readerId) {
      setError('Pick a card reader.');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ receiptId: string; paymentIntentId: string }>(
        '/api/staff/terminal/collect-receipt',
        {
          method: 'POST',
          body: JSON.stringify({
            readerId,
            payerClientId,
            paymentDate,
            reference: reference.trim() || null,
            allocations: v.allocations,
          }),
        },
      );
      setTerminalPending({ receiptId: r.receiptId, paymentIntentId: r.paymentIntentId });
      pollReceipt(r.receiptId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'terminal_failed');
    } finally {
      setBusy(false);
    }
  }

  async function cancelTerminal(): Promise<void> {
    if (!terminalPending) return;
    if (pollRef.current) clearInterval(pollRef.current);
    const pi = terminalPending.paymentIntentId;
    setTerminalPending(null);
    await api('/api/staff/terminal/cancel', {
      method: 'POST',
      body: JSON.stringify({ paymentIntentId: pi }),
    }).catch(() => undefined);
  }

  // ---- Mode change resets the method ----
  useEffect(() => {
    if (mode === 'CHARGE') setPaymentMethod('CARD_STRIPE');
    else if (paymentMethod === 'CARD_STRIPE') setPaymentMethod('CHECK');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const totalAllocated = totalAllocatedCents();
  const totalCreditApplied = totalCreditAppliedCents();
  const totalEntered = dollarsToCents(amountDollars);
  const unallocated = totalEntered - totalAllocated; // surplus → becomes credit
  const isPureCreditApply = totalEntered === 0 && totalCreditApplied > 0;

  const includedEntities = useMemo(() => {
    const byId = new Map<string, string>();
    for (const c of allClients) byId.set(c.id, c.name);
    for (const s of suggested) byId.set(s.clientId, s.clientName);
    return includedClientIds.map((id) => ({ id, name: byId.get(id) ?? id.slice(0, 8) }));
  }, [includedClientIds, allClients, suggested]);

  const chargeAvailable = config.stripeEnabled && config.ccEnabled;

  // Full success screen (single record) — replaces the form.
  if (recorded && !recorded.banner) {
    return (
      <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 680 }}>
        <Card title="Payment recorded">
          <p style={{ fontSize: 14, marginTop: 0 }}>
            ✓ Recorded <strong>{dollars(recorded.amountCents)}</strong> from{' '}
            <strong>{recorded.clientName}</strong>.
          </p>
          <div style={{ marginTop: 8 }}>
            <ReceiptActions receiptId={recorded.receiptId} />
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <Button
              onClick={() => {
                resetForm();
                setRecorded(null);
              }}
            >
              Record another payment
            </Button>
            <Button variant="ghost" onClick={() => navigate('/ar')}>
              Done
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 1200 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0, fontSize: 22 }}>Receive payment</h1>
      </div>

      {recorded?.banner && (
        <div
          role="status"
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            background: tokens.color.surface,
            border: `1px solid ${tokens.color.success}`,
            borderRadius: tokens.radius.md,
            padding: '10px 14px',
            fontSize: 13,
          }}
        >
          <span>
            ✓ Recorded <strong>{dollars(recorded.amountCents)}</strong> from{' '}
            <strong>{recorded.clientName}</strong>.
          </span>
          <ReceiptActions receiptId={recorded.receiptId} />
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setRecorded(null)}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: tokens.color.textMuted,
              fontSize: 16,
            }}
          >
            ×
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          style={{
            background: tokens.color.surface,
            color: tokens.color.danger,
            padding: 12,
            borderRadius: tokens.radius.md,
            border: `1px solid ${tokens.color.danger}`,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr',
          gap: tokens.space.lg,
        }}
      >
        <Card title="Record or charge">
          <div style={{ display: 'grid', gap: 12 }}>
            <ModeRadio
              checked={mode === 'RECORD'}
              onChange={() => setMode('RECORD')}
              label="Record payment"
              hint="Received via check, cash, other."
            />
            <ModeRadio
              checked={mode === 'CHARGE'}
              disabled={!chargeAvailable}
              onChange={() => setMode('CHARGE')}
              label="Charge new payment"
              hint={
                chargeAvailable
                  ? 'Process a card via Stripe.'
                  : 'Stripe + credit card processing must be enabled in firm settings.'
              }
            />
            {terminalAvailable && (
              <ModeRadio
                checked={mode === 'TERMINAL'}
                onChange={() => setMode('TERMINAL')}
                label="In-person terminal"
                hint="Tap or insert a card on a connected reader."
              />
            )}

            {mode === 'TERMINAL' && (
              <div>
                <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
                  Card reader
                </div>
                <select
                  value={readerId}
                  onChange={(e) => setReaderId(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.color.border}`,
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    fontSize: 13,
                  }}
                >
                  <option value="">— pick a reader —</option>
                  {readers.map((rd) => (
                    <option key={rd.id} value={rd.id}>
                      {rd.label} ({rd.status})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <Input
                label="Payment date"
                type="date"
                value={paymentDate}
                onChange={(e) => setPaymentDate(e.target.value)}
              />
              <Input
                label="Reference no."
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Check #, wire conf #, etc."
              />
            </div>

            <div>
              <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
                Payment method
              </div>
              {mode === 'RECORD' ? (
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                  style={{
                    width: '100%',
                    padding: '6px 10px',
                    borderRadius: tokens.radius.md,
                    border: `1px solid ${tokens.color.border}`,
                    background: tokens.color.surface,
                    color: tokens.color.text,
                    fontSize: 13,
                  }}
                >
                  {methods.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              ) : (
                <div style={{ fontSize: 13 }}>Card via Stripe</div>
              )}
            </div>
          </div>
        </Card>

        <Card title="Amount">
          <Input
            label="Amount received ($)"
            type="text"
            inputMode="decimal"
            value={amountDollars}
            onChange={(e) => setAmountDollars(e.target.value)}
            placeholder="0.00"
          />
          {(totalEntered > 0 || totalCreditApplied > 0) && (
            <div
              style={{
                fontSize: 12,
                marginTop: 8,
                display: 'grid',
                gap: 2,
                borderTop: `1px solid ${tokens.color.border}`,
                paddingTop: 6,
              }}
            >
              <SummaryRow label="Received" value={dollars(totalEntered)} />
              <SummaryRow label="Allocated" value={dollars(totalAllocated)} />
              {totalCreditApplied > 0 && (
                <SummaryRow label="Credit applied" value={dollars(totalCreditApplied)} />
              )}
              {unallocated > 0 && (
                <div style={{ color: tokens.color.warning, marginTop: 2 }}>
                  {dollars(unallocated)} surplus → becomes a credit on submit
                </div>
              )}
              {totalAllocated > totalEntered && (
                <div style={{ color: tokens.color.danger, marginTop: 2 }}>
                  Allocated exceeds received by {dollars(totalAllocated - totalEntered)}.
                </div>
              )}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginBottom: 4 }}>
              Payee
            </div>
            <Combobox
              ariaLabel="Payer"
              clearable
              value={payerClientId}
              onChange={(v) => {
                setPayerClientId(v || '');
                setIncludedClientIds([]); // reset added entities
              }}
              options={allClients.map<ComboboxOption>((c) => ({ value: c.id, label: c.name }))}
              filterFn={(opt, q) => opt.label.toLowerCase().includes(q.toLowerCase())}
              placeholder="Search clients…"
            />
          </div>
        </Card>
      </div>

      {payerClientId && (
        <Card title="Entities included">
          <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0, marginBottom: 8 }}>
            One payer may cover invoices for multiple entities they own.
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <Pill tone="accent">
              {allClients.find((c) => c.id === payerClientId)?.name ?? 'Payer'} · primary
            </Pill>
            {includedEntities.map((e) => (
              <Pill key={e.id} tone="neutral">
                {e.name}
                <button
                  type="button"
                  onClick={() => removeEntity(e.id)}
                  aria-label={`Remove ${e.name}`}
                  style={{
                    marginLeft: 6,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    color: 'inherit',
                  }}
                >
                  ×
                </button>
              </Pill>
            ))}
          </div>
          {suggested.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 6 }}>
                Suggested (shared portal access):
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {suggested
                  .filter((s) => !includedClientIds.includes(s.clientId))
                  .map((s) => (
                    <Button
                      key={s.clientId}
                      size="sm"
                      variant="ghost"
                      onClick={() => addEntity(s.clientId)}
                    >
                      + {s.clientName}
                    </Button>
                  ))}
              </div>
            </div>
          )}
          <div style={{ marginTop: 12, maxWidth: 360 }}>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 4 }}>
              Add another entity
            </div>
            <Combobox
              ariaLabel="Add entity"
              clearable
              value=""
              onChange={(v) => {
                if (v) addEntity(v);
              }}
              options={allClients
                .filter((c) => c.id !== payerClientId && !includedClientIds.includes(c.id))
                .map<ComboboxOption>((c) => ({ value: c.id, label: c.name }))}
              placeholder="Search clients…"
            />
          </div>
        </Card>
      )}

      {outstanding.length > 0 && (
        <Card
          title="Outstanding transactions"
          action={
            <Button
              size="sm"
              variant="ghost"
              onClick={autoAllocate}
              disabled={totalEntered <= 0}
              title="Spread the amount received across these invoices, oldest first"
            >
              Auto-allocate
            </Button>
          }
        >
          <Table<OutstandingInvoice>
            columns={[
              {
                key: 'pick',
                header: '',
                render: (inv) => (
                  <input
                    type="checkbox"
                    aria-label={`Apply payment to invoice ${inv.invoiceNumber}`}
                    checked={drafts[inv.id]?.selected ?? false}
                    onChange={() => toggleInvoice(inv.id)}
                  />
                ),
              },
              {
                key: 'desc',
                header: 'Description',
                render: (inv) => (
                  <span>
                    <a
                      href={`/invoices/${inv.id}`}
                      style={{ color: tokens.color.accent, textDecoration: 'none' }}
                    >
                      Invoice #{inv.invoiceNumber}
                    </a>
                    {inv.issueDate && (
                      <span style={{ fontSize: 11, color: tokens.color.textMuted, marginLeft: 6 }}>
                        ({inv.issueDate})
                      </span>
                    )}
                  </span>
                ),
              },
              { key: 'client', header: 'Client', render: (inv) => inv.clientName },
              { key: 'due', header: 'Due', render: (inv) => inv.dueDate ?? '—' },
              {
                key: 'orig',
                header: 'Original',
                align: 'right',
                render: (inv) => dollars(inv.totalCents),
              },
              {
                key: 'open',
                header: 'Open balance',
                align: 'right',
                render: (inv) => dollars(inv.openCents),
              },
              {
                key: 'pay',
                header: 'Payment',
                align: 'right',
                render: (inv) => (
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={`Payment amount for invoice ${inv.invoiceNumber}`}
                    disabled={!drafts[inv.id]?.selected}
                    value={drafts[inv.id]?.amountDollars ?? ''}
                    onChange={(e) => setAllocation(inv.id, e.target.value)}
                    style={{
                      width: 110,
                      padding: '4px 8px',
                      textAlign: 'right',
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                      background: drafts[inv.id]?.selected ? tokens.color.surface : tokens.color.bg,
                      color: tokens.color.text,
                      fontSize: 13,
                    }}
                  />
                ),
              },
            ]}
            rows={outstanding}
            rowKey={(inv) => inv.id}
            empty="No outstanding invoices for the included clients."
          />
        </Card>
      )}

      {payerClientId && mode === 'RECORD' && openCredits.length > 0 && (
        <Card title={`Open credits (${openCredits.length})`}>
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0, marginBottom: 12 }}>
            Credits on file for the included clients. Pick a target invoice (must be selected above)
            to apply each credit. Credits can apply to any selected invoice within this firm —
            cross-entity allowed.
          </p>
          {selectableInvoices.length === 0 && (
            <p
              style={{
                fontSize: 12,
                color: tokens.color.warning,
                margin: 0,
                marginBottom: 8,
              }}
            >
              Select at least one invoice above to enable credit application.
            </p>
          )}
          <Table<OpenCredit>
            columns={[
              {
                key: 'pick',
                header: '',
                render: (c) => (
                  <input
                    type="checkbox"
                    aria-label={`Apply credit from ${c.clientName}`}
                    checked={creditDrafts[c.id]?.selected ?? false}
                    disabled={selectableInvoices.length === 0}
                    onChange={() => toggleCredit(c.id)}
                  />
                ),
              },
              {
                key: 'client',
                header: 'Client',
                render: (c) => c.clientName,
              },
              {
                key: 'source',
                header: 'Source',
                render: (c) => (
                  <Pill tone={c.source === 'MANUAL' ? 'neutral' : 'accent'}>
                    {c.source === 'MANUAL'
                      ? 'manual'
                      : c.source === 'OVERPAYMENT'
                        ? 'overpay'
                        : 'refund excess'}
                  </Pill>
                ),
              },
              {
                key: 'ref',
                header: 'Reference',
                render: (c) => (
                  <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {c.reference ?? '—'}
                  </span>
                ),
              },
              {
                key: 'date',
                header: 'Issued',
                render: (c) => c.issuedDate,
              },
              {
                key: 'remaining',
                header: 'Remaining',
                align: 'right',
                render: (c) => dollars(c.remainingAmountCents),
              },
              {
                key: 'target',
                header: 'Apply to invoice',
                render: (c) => {
                  const cur = creditDrafts[c.id];
                  return (
                    <select
                      aria-label={`Target invoice for credit ${c.id}`}
                      disabled={!cur?.selected || selectableInvoices.length === 0}
                      value={cur?.invoiceId ?? ''}
                      onChange={(e) => {
                        const invId = e.target.value;
                        const inv = outstanding.find((o) => o.id === invId);
                        const remainingForInv = inv
                          ? Math.max(
                              0,
                              inv.openCents - dollarsToCents(drafts[invId]?.amountDollars ?? '0'),
                            )
                          : 0;
                        const apply = Math.min(c.remainingAmountCents, remainingForInv);
                        setCreditField(c.id, {
                          invoiceId: invId,
                          amountDollars: apply > 0 ? centsToDollarsInput(apply) : '',
                        });
                      }}
                      style={{
                        padding: '4px 8px',
                        borderRadius: tokens.radius.sm,
                        border: `1px solid ${tokens.color.border}`,
                        background: cur?.selected ? tokens.color.surface : tokens.color.bg,
                        color: tokens.color.text,
                        fontSize: 13,
                      }}
                    >
                      <option value="">— select invoice —</option>
                      {selectableInvoices.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  );
                },
              },
              {
                key: 'amount',
                header: 'Apply',
                align: 'right',
                render: (c) => (
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={`Apply amount for credit ${c.id}`}
                    disabled={!creditDrafts[c.id]?.selected || !creditDrafts[c.id]?.invoiceId}
                    value={creditDrafts[c.id]?.amountDollars ?? ''}
                    onChange={(e) => setCreditField(c.id, { amountDollars: e.target.value })}
                    style={{
                      width: 110,
                      padding: '4px 8px',
                      textAlign: 'right',
                      border: `1px solid ${tokens.color.border}`,
                      borderRadius: tokens.radius.sm,
                      background: creditDrafts[c.id]?.selected
                        ? tokens.color.surface
                        : tokens.color.bg,
                      color: tokens.color.text,
                      fontSize: 13,
                    }}
                  />
                ),
              },
            ]}
            rows={openCredits}
            rowKey={(c) => c.id}
            empty="No open credits."
          />
        </Card>
      )}

      {mode === 'CHARGE' && chargeReceipt && stripePromise && (
        <Card title="Confirm card">
          <Elements
            stripe={stripePromise}
            options={{ clientSecret: chargeReceipt.clientSecret, appearance: { theme: 'stripe' } }}
          >
            <StripeChargeForm
              receiptId={chargeReceipt.receiptId}
              onComplete={(id) =>
                setRecorded({
                  receiptId: id,
                  clientName: payerName(),
                  amountCents: dollarsToCents(amountDollars),
                  banner: false,
                })
              }
              onError={(msg) => setError(msg)}
            />
          </Elements>
        </Card>
      )}

      {mode === 'TERMINAL' && terminalPending && (
        <Card title="Waiting for the card reader">
          <p style={{ fontSize: 13, margin: 0 }}>
            Sent {dollars(totalEntered)} to the reader — ask the client to tap, insert, or swipe
            their card. This screen updates automatically when the payment completes.
          </p>
        </Card>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {mode === 'TERMINAL' && terminalPending ? (
          <Button variant="danger" onClick={() => void cancelTerminal()}>
            Cancel charge
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => navigate('/ar')} disabled={busy}>
            Cancel
          </Button>
        )}
        {mode === 'RECORD' && (
          <>
            <Button onClick={() => void submitRecord(false)} disabled={busy}>
              {busy
                ? 'Saving…'
                : isPureCreditApply
                  ? `Apply ${dollars(totalCreditApplied)} from credits`
                  : 'Record payment'}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void submitRecord(true)}
              disabled={busy || isPureCreditApply}
              title="Record this payment, then start a new one for another client"
            >
              Record + New
            </Button>
          </>
        )}
        {mode === 'CHARGE' && !chargeReceipt && (
          <Button onClick={() => void startCharge()} disabled={busy || !chargeAvailable}>
            {busy ? 'Preparing charge…' : `Charge ${dollars(totalEntered)}`}
          </Button>
        )}
        {mode === 'TERMINAL' && !terminalPending && (
          <Button onClick={() => void startTerminal()} disabled={busy || !readerId}>
            {busy ? 'Sending…' : `Send ${dollars(totalEntered)} to reader`}
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
// Mode radio — extracted so the label can carry direct text content
// (jsx-a11y/label-has-associated-control wants real text inside <label>,
// not just a nested element tree).
// ---------------------------------------------------------------------

function SummaryRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: tokens.color.textMuted }}>{label}</span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  );
}

// Print or email the receipt for a recorded payment. Email goes to the
// client's billing contact (falling back to primary).
function ReceiptActions({ receiptId }: { receiptId: string }): JSX.Element {
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
      <Button size="sm" variant="secondary" disabled={sending} onClick={() => void emailReceipt()}>
        {sending ? 'Emailing…' : 'Email receipt'}
      </Button>
      {msg && <span style={{ fontSize: 12, color: tokens.color.textMuted }}>{msg}</span>}
    </span>
  );
}

function ModeRadio({
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  label: string;
  hint: string;
}): JSX.Element {
  return (
    // eslint-disable-next-line jsx-a11y/label-has-associated-control
    <label
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <input
        type="radio"
        name="mode"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={onChange}
      />
      <span>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 500 }}>{label}</span>
        <span style={{ display: 'block', fontSize: 12, color: tokens.color.textMuted }}>
          {hint}
        </span>
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------
// Stripe Elements confirm + poll
// ---------------------------------------------------------------------

function StripeChargeForm({
  receiptId,
  onComplete,
  onError,
}: {
  receiptId: string;
  onComplete: (receiptId: string) => void;
  onError: (msg: string) => void;
}): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [phase, setPhase] = useState<'idle' | 'confirming' | 'awaiting_webhook'>('idle');
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, []);

  async function confirm(): Promise<void> {
    if (!stripe || !elements) return;
    setPhase('confirming');
    const { error } = await stripe.confirmPayment({
      elements,
      // No return_url — we stay on the page and poll our own /receive/:id.
      redirect: 'if_required',
    });
    if (error) {
      onError(error.message ?? 'Card confirmation failed.');
      setPhase('idle');
      return;
    }
    setPhase('awaiting_webhook');
    let elapsed = 0;
    const intervalMs = 1500;
    pollRef.current = window.setInterval(async () => {
      elapsed += intervalMs;
      try {
        const r = await api<{ receipt: { status: string } | null }>(
          `/api/staff/payments/receive/${encodeURIComponent(receiptId)}`,
        );
        if (r.receipt?.status === 'SUCCEEDED') {
          if (pollRef.current != null) window.clearInterval(pollRef.current);
          onComplete(receiptId);
          return;
        }
        if (r.receipt?.status === 'FAILED') {
          if (pollRef.current != null) window.clearInterval(pollRef.current);
          onError('Card charge failed — see Stripe dashboard for details.');
          setPhase('idle');
          return;
        }
      } catch {
        // transient — keep polling
      }
      if (elapsed >= 20_000) {
        if (pollRef.current != null) window.clearInterval(pollRef.current);
        onError(
          'Charge is still processing. The webhook will complete it shortly — check AR in a moment.',
        );
        setPhase('idle');
      }
    }, intervalMs);
  }

  return (
    <div>
      <PaymentElement />
      <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
        <Button onClick={() => void confirm()} disabled={!stripe || phase !== 'idle'}>
          {phase === 'confirming'
            ? 'Confirming…'
            : phase === 'awaiting_webhook'
              ? 'Awaiting Stripe…'
              : 'Confirm charge'}
        </Button>
      </div>
    </div>
  );
}
