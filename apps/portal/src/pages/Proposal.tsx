// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
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

import { Button, Card, Markdown, Pill, tokens } from '@vibe/ui';
import { parseVideoUrl } from '@vibe/core/proposals';

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

interface ThisSigner {
  id: string;
  name: string;
  email: string;
  role: string;
  sequence: number;
  state: string;
}

interface RosterSigner {
  name: string;
  role: string;
  state: string;
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
  // Q34 — present only for per-signer (multi-signer) links.
  thisSigner?: ThisSigner;
  signers?: RosterSigner[];
  signedCount?: number;
  requiredCount?: number;
  signingOrderMode?: string;
}

interface AcceptResponse {
  ok?: boolean;
  signatureId: string;
  engagementId?: string | null;
  remaining?: number;
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
interface SelectContext {
  selectedPkg: string | null;
  onSelectPkg: (packageId: string) => void;
}

function renderBlock(block: BrochureBlock, key: string, sel?: SelectContext): JSX.Element {
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
      const level = Math.min(6, Math.max(1, Number(props['level'] ?? 2)));
      const text = String(props['text'] ?? '');
      const sizes = [26, 22, 18, 16, 14, 13];
      return (
        <div
          key={key}
          style={{ marginTop: 18, marginBottom: 8, fontSize: sizes[level - 1], fontWeight: 600 }}
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
    // ---- Editor block types (hydrated server-side by the redeem endpoint) ----
    case 'cover': {
      const title = String(props['title'] ?? '');
      const subtitle = String(props['subtitle'] ?? '');
      const hero = String(props['heroImageUrl'] ?? '');
      return (
        <div key={key} style={{ marginBottom: 24 }}>
          {hero && (
            <img
              src={hero}
              alt=""
              style={{
                width: '100%',
                maxHeight: 280,
                objectFit: 'cover',
                borderRadius: tokens.radius.md,
                marginBottom: 12,
              }}
            />
          )}
          {title && <h1 style={{ fontSize: 30, margin: '0 0 8px' }}>{title}</h1>}
          {subtitle && (
            <p style={{ fontSize: 16, color: tokens.color.textMuted, margin: 0 }}>{subtitle}</p>
          )}
        </div>
      );
    }
    case 'markdown': {
      const md = String(props['md'] ?? '');
      if (!md.trim()) return <div key={key} />;
      return (
        <div key={key} style={{ marginBottom: 12 }}>
          <Markdown source={md} />
        </div>
      );
    }
    case 'divider':
      return (
        <hr
          key={key}
          style={{ border: 0, borderTop: `1px solid ${tokens.color.border}`, margin: '16px 0' }}
        />
      );
    case 'video': {
      const parsed = parseVideoUrl(String(props['url'] ?? ''));
      if (!parsed) return <div key={key} />;
      return (
        <div
          key={key}
          style={{
            position: 'relative',
            paddingBottom: '56.25%',
            height: 0,
            margin: '12px 0',
            borderRadius: tokens.radius.sm,
            overflow: 'hidden',
          }}
        >
          <iframe
            src={parsed.embedUrl}
            title="Video"
            allow="fullscreen"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
          />
        </div>
      );
    }
    case 'services_list': {
      const showPrices = props['showPrices'] !== false;
      const items = (props['items'] as { name: string; priceCents: number }[] | undefined) ?? [];
      if (items.length === 0) return <div key={key} />;
      return (
        <ul key={key} style={{ paddingLeft: 20, marginBottom: 12 }}>
          {items.map((s, i) => (
            <li key={i} style={{ fontSize: 14, lineHeight: 1.6 }}>
              {s.name}
              {showPrices && (
                <span style={{ color: tokens.color.textMuted, marginLeft: 6, fontSize: 13 }}>
                  {' '}
                  — {money(Number(s.priceCents))}
                </span>
              )}
            </li>
          ))}
        </ul>
      );
    }
    case 'package_selector': {
      const name = String(props['packageName'] ?? '');
      const tiers =
        (props['tiers'] as
          | {
              packageId?: string;
              tierLabel: string;
              priceCents: number;
              description: string;
              includedServiceCount: number;
            }[]
          | undefined) ?? [];
      if (tiers.length === 0) return <div key={key} />;
      // Selectable when the tiers carry a packageId (hydrated) and the page
      // passed a selection context. Otherwise fall back to display-only cards.
      const selectable = !!sel && tiers.some((t) => !!t.packageId);
      return (
        <div key={key} style={{ marginBottom: 16 }}>
          {name && <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{name}</div>}
          <div
            style={{
              display: 'grid',
              gap: 12,
              gridTemplateColumns: `repeat(${Math.min(tiers.length, 3)}, 1fr)`,
            }}
          >
            {tiers.map((t) => {
              const isSelected = selectable && !!t.packageId && sel!.selectedPkg === t.packageId;
              const inner = (
                <>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{t.tierLabel}</div>
                    {isSelected && <Pill tone="accent">Selected</Pill>}
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 700, margin: '4px 0' }}>
                    {money(Number(t.priceCents))}
                  </div>
                  {t.description?.trim() && (
                    <div style={{ fontSize: 13, margin: '4px 0' }}>
                      <Markdown source={t.description} />
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                    {t.includedServiceCount} included
                  </div>
                </>
              );
              const cardStyle: React.CSSProperties = {
                textAlign: 'left',
                padding: 16,
                border: `${isSelected ? 2 : 1}px solid ${
                  isSelected ? tokens.color.accent : tokens.color.border
                }`,
                borderRadius: tokens.radius.md,
                background: isSelected ? 'rgba(67, 56, 202, 0.04)' : tokens.color.surface,
              };
              if (selectable && t.packageId) {
                const pkgId = t.packageId;
                return (
                  <button
                    key={pkgId}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => sel!.onSelectPkg(pkgId)}
                    style={{
                      ...cardStyle,
                      cursor: 'pointer',
                      display: 'flex',
                      flexDirection: 'column',
                      width: '100%',
                    }}
                  >
                    {inner}
                  </button>
                );
              }
              return (
                <div key={t.packageId ?? t.tierLabel} style={cardStyle}>
                  {inner}
                </div>
              );
            })}
          </div>
        </div>
      );
    }
    case 'terms': {
      const md = String(props['contentMd'] ?? '');
      if (!md.trim()) return <div key={key} />;
      return (
        <div key={key} style={{ marginBottom: 12 }}>
          <Markdown source={md} />
        </div>
      );
    }
    case 'signature':
      // The actual typed-name/accept UI renders at the bottom of the page; this
      // block just marks where signing sits in the document.
      return (
        <div
          key={key}
          style={{
            margin: '12px 0',
            padding: 12,
            border: `1px dashed ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            color: tokens.color.textMuted,
            fontSize: 13,
          }}
        >
          Signature &amp; acceptance — complete below.
        </div>
      );

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
      // Q34 — prefill the signer identity from the per-signer link.
      if (r.thisSigner) {
        setSignerName(r.thisSigner.name);
        setSignerEmail(r.thisSigner.email);
        setTypedName(r.thisSigner.name);
      }
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

  // Legacy top-level packages (older brochures). New proposals offer tiers via
  // hydrated package_selector blocks instead.
  const packages = useMemo(() => data?.proposal.brochureJsonb.packages ?? [], [data]);

  // Selectable package tiers offered by package_selector blocks. The redeem
  // endpoint hydrates each tier with its packageId.
  const blockTierIds = useMemo(() => {
    const ids: string[] = [];
    for (const b of data?.proposal.brochureJsonb.blocks ?? []) {
      if (b.type !== 'package_selector') continue;
      const tiers = (b.props?.['tiers'] as { packageId?: string }[] | undefined) ?? [];
      for (const t of tiers) {
        if (t.packageId && !ids.includes(t.packageId)) ids.push(t.packageId);
      }
    }
    return ids;
  }, [data]);

  const hasSelectablePackages = blockTierIds.length > 0 || packages.length > 0;

  // Auto-select a default so the Accept button isn't blocked: the first offered
  // tier, or the highlighted/first legacy package.
  useEffect(() => {
    if (selectedPkg || !hasSelectablePackages) return;
    if (blockTierIds.length > 0) {
      setSelectedPkg(blockTierIds[0]!);
      return;
    }
    const highlighted = packages.find((p) => p.highlighted);
    setSelectedPkg(highlighted?.id ?? packages[0]!.id);
  }, [packages, blockTierIds, hasSelectablePackages, selectedPkg]);

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
      setAccepted({ ...r, remaining: r.remaining ?? 0 });
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
                    : error === 'already_signed'
                      ? 'You have already signed this proposal. Thank you.'
                      : error === 'declined'
                        ? 'This signing request was declined. Please contact your firm if this is unexpected.'
                        : error === 'not_your_turn'
                          ? 'It is not your turn to sign yet. You will receive a fresh link once the earlier signer(s) have signed.'
                          : `We couldn't load this proposal: ${error ?? 'unknown error'}.`}
          </p>
        </Card>
      </CenteredShell>
    );
  }

  if (step === 'done' && accepted) {
    const remaining = accepted.remaining ?? 0;
    return (
      <CenteredShell>
        <Card title="Thank you">
          <div style={{ display: 'grid', gap: 12 }}>
            <div style={{ fontSize: 28, textAlign: 'center' }} aria-hidden>
              ✅
            </div>
            <p style={{ fontSize: 15, lineHeight: 1.5, textAlign: 'center' }}>
              {remaining > 0
                ? `Your signature has been recorded. ${remaining} more signature${
                    remaining === 1 ? '' : 's'
                  } needed before this proposal is fully accepted.`
                : 'Your acceptance has been recorded. Your firm will contact you with next steps and the engagement letter.'}
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
    (hasSelectablePackages && !selectedPkg);

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

      {data.thisSigner && (
        <Card title="Your signature">
          <p style={{ fontSize: 14, margin: '0 0 8px' }}>
            You are <strong>{data.thisSigner.role}</strong> — signer {data.thisSigner.sequence + 1}{' '}
            of {data.requiredCount ?? data.signers?.length ?? 1}.
          </p>
          {data.signers && data.signers.length > 0 && (
            <div style={{ display: 'grid', gap: 6 }}>
              {data.signers.map((s, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    gap: 8,
                    alignItems: 'center',
                    fontSize: 13,
                  }}
                >
                  <span style={{ flex: 1 }}>
                    {s.name} <span style={{ color: tokens.color.textMuted }}>({s.role})</span>
                  </span>
                  <Pill
                    tone={
                      s.state === 'SIGNED'
                        ? 'success'
                        : s.state === 'DECLINED'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {s.state}
                  </Pill>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <div
        style={{
          background: tokens.color.surface,
          padding: 24,
          borderRadius: tokens.radius.md,
          marginBottom: 16,
          marginTop: 16,
        }}
      >
        {data.proposal.brochureJsonb.blocks.map((b, i) =>
          renderBlock(b, b.id ?? String(i), { selectedPkg, onSelectPkg: setSelectedPkg }),
        )}
      </div>

      {packages.length > 0 && blockTierIds.length === 0 && (
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
        blockTierIds.length === 0 &&
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
