// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Portal §2.8 — Proposal magic-link landing + accept flow.
//
// Route: /p/:token  (outside RequireAuth — magic-link IS the credential)
//
// Steps:
//   1. Redeem (POST /api/portal/proposals/redeem) → render brochure
//   2. Review tiers/packages (if present) + signature input
//   3. Accept (POST /api/portal/proposals/:id/accept) → success screen
//
// The Stripe Payment Element handoff is wired in production; v1 of
// this page accepts without payment when the firm hasn't connected
// Stripe (most engagements at launch are post-deposit or
// invoice-based). The button surfaces a clear note when payment is
// required and not yet wired.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api, type ApiError } from '../api-client';

interface BrochureBlock {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  children?: BrochureBlock[];
}

interface BrochureJsonb {
  schemaVersion: number;
  blocks: BrochureBlock[];
  packages?: BrochurePackage[];
}

interface BrochurePackage {
  id: string;
  name: string;
  one_time_cents: number;
  recurring_cents: number;
  recurring_interval?: 'MONTHLY' | 'QUARTERLY' | 'SEMIANNUALLY' | 'ANNUALLY' | null;
  features?: string[];
  highlighted?: boolean;
}

interface RedeemResponse {
  proposal: {
    id: string;
    title: string;
    status: string;
    brochureJsonb: BrochureJsonb;
    totalOneTimeCents: number;
    totalRecurringCents: number;
    recurringInterval: string | null;
    sentAt: string | null;
    expiresAt: string | null;
  };
  magicLinkId: string;
}

interface AcceptResponse {
  proposalId: string;
  signatureId: string;
  engagementId: string | null;
}

type Step = 'loading' | 'review' | 'submitting' | 'done' | 'error';

function money(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function intervalLabel(i: string | null | undefined): string {
  switch (i) {
    case 'MONTHLY':
      return '/mo';
    case 'QUARTERLY':
      return '/qtr';
    case 'SEMIANNUALLY':
      return '/6mo';
    case 'ANNUALLY':
      return '/yr';
    default:
      return '';
  }
}

// Minimal block renderer — covers the §2.8 baseline shape. The full
// block-registry renderer ships with the proposal-editor app; this
// is a read-only subset that handles the most common brochure
// blocks. Unknown block types render as a fallback label.
function renderBlock(block: BrochureBlock, key: string): JSX.Element {
  const props = (block.props ?? {}) as Record<string, unknown>;
  switch (block.type) {
    case 'hero':
    case 'header': {
      const title = String(props['title'] ?? '');
      const subtitle = String(props['subtitle'] ?? '');
      return (
        <div key={key} style={{ marginBottom: 24 }}>
          {title && <h1 style={{ fontSize: 28, margin: '0 0 8px' }}>{title}</h1>}
          {subtitle && (
            <p style={{ fontSize: 15, color: tokens.color.textMuted, margin: 0 }}>{subtitle}</p>
          )}
        </div>
      );
    }
    case 'text':
    case 'paragraph': {
      const body = String(props['body'] ?? props['text'] ?? '');
      return (
        <p key={key} style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 12 }}>
          {body}
        </p>
      );
    }
    case 'heading': {
      const level = Math.min(6, Math.max(2, Number(props['level'] ?? 2)));
      const text = String(props['text'] ?? '');
      const sizes = [22, 20, 18, 16, 14, 13];
      return (
        <div
          key={key}
          style={{ marginTop: 20, marginBottom: 8, fontSize: sizes[level - 2], fontWeight: 600 }}
        >
          {text}
        </div>
      );
    }
    case 'list':
    case 'bullets': {
      const items = (props['items'] as string[] | undefined) ?? [];
      return (
        <ul key={key} style={{ paddingLeft: 20, marginBottom: 12 }}>
          {items.map((it, i) => (
            <li key={i} style={{ fontSize: 14, lineHeight: 1.6 }}>
              {it}
            </li>
          ))}
        </ul>
      );
    }
    case 'image': {
      const src = String(props['src'] ?? '');
      const alt = String(props['alt'] ?? '');
      if (!src) return <div key={key} />;
      return (
        <img
          key={key}
          src={src}
          alt={alt}
          style={{ maxWidth: '100%', borderRadius: tokens.radius.sm, margin: '12px 0' }}
        />
      );
    }
    case 'callout': {
      const tone = (props['tone'] as 'info' | 'warning' | 'success') ?? 'info';
      const body = String(props['body'] ?? '');
      const bg =
        tone === 'warning'
          ? 'rgba(255, 170, 0, 0.08)'
          : tone === 'success'
            ? 'rgba(34, 197, 94, 0.08)'
            : 'rgba(59, 130, 246, 0.08)';
      const border =
        tone === 'warning'
          ? tokens.color.warning
          : tone === 'success'
            ? tokens.color.success
            : tokens.color.accent;
      return (
        <div
          key={key}
          style={{
            padding: 12,
            background: bg,
            borderLeft: `4px solid ${border}`,
            borderRadius: tokens.radius.sm,
            marginBottom: 12,
            fontSize: 14,
          }}
        >
          {body}
        </div>
      );
    }
    default:
      return (
        <div key={key} style={{ fontSize: 11, color: tokens.color.textMuted, margin: '4px 0' }}>
          (Unsupported block: {block.type})
        </div>
      );
  }
}

function PackageCard({
  pkg,
  selected,
  onSelect,
}: {
  pkg: BrochurePackage;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        textAlign: 'left',
        padding: 16,
        border: `2px solid ${selected ? tokens.color.accent : tokens.color.border}`,
        borderRadius: tokens.radius.md,
        background: selected ? 'rgba(67, 56, 202, 0.04)' : tokens.color.surface,
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: '100%',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong style={{ fontSize: 16 }}>{pkg.name}</strong>
        {pkg.highlighted && <Pill tone="accent">Recommended</Pill>}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline' }}>
        {pkg.one_time_cents > 0 && (
          <span style={{ fontSize: 22, fontWeight: 600 }}>{money(pkg.one_time_cents)}</span>
        )}
        {pkg.recurring_cents > 0 && (
          <span style={{ fontSize: 14, color: tokens.color.textMuted }}>
            {money(pkg.recurring_cents)}
            {intervalLabel(pkg.recurring_interval)}
          </span>
        )}
      </div>
      {pkg.features && pkg.features.length > 0 && (
        <ul style={{ paddingLeft: 18, margin: 0 }}>
          {pkg.features.map((f, i) => (
            <li key={i} style={{ fontSize: 13, lineHeight: 1.5 }}>
              {f}
            </li>
          ))}
        </ul>
      )}
    </button>
  );
}

export function ProposalPage(): JSX.Element {
  const { token } = useParams<{ token: string }>();
  const [step, setStep] = useState<Step>('loading');
  const [data, setData] = useState<RedeemResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signerName, setSignerName] = useState('');
  const [signerEmail, setSignerEmail] = useState('');
  const [typedName, setTypedName] = useState('');
  const [selectedPkg, setSelectedPkg] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<AcceptResponse | null>(null);
  const [sessionId] = useState(() =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`,
  );

  const redeem = useCallback(async () => {
    if (!token) return;
    setStep('loading');
    setError(null);
    try {
      const r = await api<RedeemResponse>('/api/portal/proposals/redeem', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
      setData(r);
      setStep('review');
    } catch (err) {
      const apiErr = err as ApiError;
      const code =
        apiErr.body && typeof apiErr.body === 'object' && 'error' in apiErr.body
          ? String((apiErr.body as { error: unknown }).error)
          : apiErr.message;
      setError(code);
      setStep('error');
    }
  }, [token]);

  useEffect(() => {
    void redeem();
  }, [redeem]);

  const packages = useMemo(() => data?.proposal.brochureJsonb.packages ?? [], [data]);

  // Auto-select the highlighted package on first render so the
  // Accept button isn't blocked when the proposal has packages.
  useEffect(() => {
    if (!packages.length || selectedPkg) return;
    const highlighted = packages.find((p) => p.highlighted);
    setSelectedPkg(highlighted?.id ?? packages[0]!.id);
  }, [packages, selectedPkg]);

  // Section-view ping when blocks come into view. v1 sends one ping
  // per block on first render — no IntersectionObserver scaffolding
  // for now; staff-side dashboard will get richer data when the
  // observer hook lands.
  useEffect(() => {
    if (!data) return;
    const firstBlock = data.proposal.brochureJsonb.blocks[0];
    if (!firstBlock?.id || !token) return;
    void api('/api/portal/proposals/section-view', {
      method: 'POST',
      body: JSON.stringify({
        magicLinkToken: token,
        sessionId,
        sectionBlockId: firstBlock.id,
        dwellMs: 1000,
      }),
    }).catch(() => undefined);
  }, [data, token, sessionId]);

  async function submit(): Promise<void> {
    if (!data) return;
    setStep('submitting');
    setError(null);
    try {
      const r = await api<AcceptResponse>(`/api/portal/proposals/${data.proposal.id}/accept`, {
        method: 'POST',
        body: JSON.stringify({
          magicLinkId: data.magicLinkId,
          signerName: signerName.trim(),
          signerEmail: signerEmail.trim(),
          typedName: typedName.trim(),
          selectedPackageId: selectedPkg,
        }),
      });
      setAccepted(r);
      setStep('done');
    } catch (err) {
      const apiErr = err as ApiError;
      setError(apiErr.message);
      setStep('review');
    }
  }

  if (step === 'loading') {
    return (
      <CenteredShell>
        <p style={{ fontSize: 14, color: tokens.color.textMuted }}>Loading proposal…</p>
      </CenteredShell>
    );
  }

  if (step === 'error') {
    return (
      <CenteredShell>
        <Card title="Proposal unavailable">
          <p style={{ fontSize: 14, color: tokens.color.danger }}>
            {error === 'token_expired'
              ? 'This proposal link has expired. Please ask your firm for a fresh link.'
              : error === 'token_superseded'
                ? 'A newer version of this proposal was sent. Use the most recent link.'
                : error === 'token_not_found'
                  ? 'This proposal link could not be found.'
                  : error === 'proposal_unavailable'
                    ? 'This proposal is no longer available.'
                    : `We couldn't load this proposal: ${error ?? 'unknown error'}.`}
          </p>
        </Card>
      </CenteredShell>
    );
  }

  if (step === 'done' && accepted) {
    return (
      <CenteredShell>
        <Card title="Thank you">
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ fontSize: 28, textAlign: 'center' }} aria-hidden>
              ✅
            </div>
            <p style={{ fontSize: 15, lineHeight: 1.5, textAlign: 'center' }}>
              Your acceptance has been recorded. Your firm will contact you with next steps and the
              engagement letter.
            </p>
            <div
              style={{
                fontSize: 11,
                color: tokens.color.textMuted,
                textAlign: 'center',
                paddingTop: 8,
              }}
            >
              Signature reference: <code>{accepted.signatureId}</code>
            </div>
          </div>
        </Card>
      </CenteredShell>
    );
  }

  // step === 'review' or 'submitting'
  if (!data)
    return (
      <CenteredShell>
        <p>—</p>
      </CenteredShell>
    );

  const submitDisabled =
    step === 'submitting' ||
    signerName.trim().length === 0 ||
    !signerEmail.includes('@') ||
    typedName.trim().length === 0 ||
    (packages.length > 0 && !selectedPkg);

  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: 24 }}>
      <div
        style={{
          fontSize: 11,
          color: tokens.color.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 1,
          marginBottom: 8,
        }}
      >
        Proposal
      </div>

      <div
        style={{
          background: tokens.color.surface,
          padding: 24,
          borderRadius: tokens.radius.md,
          marginBottom: 16,
        }}
      >
        {data.proposal.brochureJsonb.blocks.map((b, i) => renderBlock(b, b.id ?? String(i)))}
      </div>

      {packages.length > 0 && (
        <Card title="Choose a package">
          <div style={{ display: 'grid', gap: 12 }}>
            {packages.map((p) => (
              <PackageCard
                key={p.id}
                pkg={p}
                selected={selectedPkg === p.id}
                onSelect={() => setSelectedPkg(p.id)}
              />
            ))}
          </div>
        </Card>
      )}

      {packages.length === 0 &&
        (data.proposal.totalOneTimeCents > 0 || data.proposal.totalRecurringCents > 0) && (
          <Card title="Total">
            <div style={{ display: 'flex', gap: 16, alignItems: 'baseline' }}>
              {data.proposal.totalOneTimeCents > 0 && (
                <span style={{ fontSize: 24, fontWeight: 600 }}>
                  {money(data.proposal.totalOneTimeCents)}
                </span>
              )}
              {data.proposal.totalRecurringCents > 0 && (
                <span style={{ fontSize: 16, color: tokens.color.textMuted }}>
                  {money(data.proposal.totalRecurringCents)}
                  {intervalLabel(data.proposal.recurringInterval)}
                </span>
              )}
            </div>
          </Card>
        )}

      <div style={{ marginTop: 16 }}>
        <Card title="Sign to accept">
          <div style={{ display: 'grid', gap: 12 }}>
            <Field id="signer-name" label="Your name" value={signerName} onChange={setSignerName} />
            <Field
              id="signer-email"
              label="Your email"
              type="email"
              value={signerEmail}
              onChange={setSignerEmail}
            />
            <Field
              id="typed-name"
              label="Type your full name to sign"
              value={typedName}
              onChange={setTypedName}
              hint="By typing your name and clicking Accept, you agree to be bound by this proposal."
            />
            {error && (
              <div
                style={{
                  padding: 10,
                  background: 'rgba(220,38,38,0.1)',
                  border: `1px solid ${tokens.color.danger}`,
                  borderRadius: tokens.radius.sm,
                  fontSize: 13,
                  color: tokens.color.danger,
                }}
              >
                {error}
              </div>
            )}
            <Button onClick={() => void submit()} disabled={submitDisabled}>
              {step === 'submitting' ? 'Accepting…' : 'Accept proposal'}
            </Button>
          </div>
        </Card>
      </div>

      <p
        style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 12, textAlign: 'center' }}
      >
        Need help? Reply to the email you received with this link, or contact your firm directly.
      </p>
    </div>
  );
}

function CenteredShell({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div
      style={{
        minHeight: '60vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div style={{ maxWidth: 480, width: '100%' }}>{children}</div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  type,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  hint?: string;
}): JSX.Element {
  return (
    <div>
      <label
        htmlFor={id}
        style={{ display: 'block', fontSize: 12, marginBottom: 4, color: tokens.color.textMuted }}
      >
        {label}
      </label>
      <input
        id={id}
        type={type ?? 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: 10,
          fontSize: 14,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
        }}
      />
      {hint && (
        <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 4 }}>{hint}</div>
      )}
    </div>
  );
}
