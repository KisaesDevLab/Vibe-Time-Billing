// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// P05 — Block type registry. Nine block types end-to-end (editor +
// renderer + defaults).
//
// Per addendum §P05 the canonical seven are: cover, markdown,
// video, services list, package selector, terms, signature. PP4a
// also seeded heading + divider as cheap structural primitives,
// which we keep alongside.
//
// Each block type is a BlockTypeDef:
//   type           — stable string saved on disk
//   label, icon    — palette display
//   defaultProps() — initial props on add
//   EditorFields   — firm-side editor UI for the props
//   Renderer       — firm preview + portal render. Portal mode is
//                    indicated by the optional `mode` prop; richer
//                    portal behaviour ships with P20 + P21.
//
// Some renderers fetch supporting data (services catalog, packages,
// terms templates). Those fetches happen inside the renderer so the
// block tree itself stays compact + portable.

import { useEffect, useState } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';
import { parseVideoUrl, resolveMergeTokens } from '@vibe/core/proposals';
import type { ProposalBlock } from '@vibe/core/proposals';

import { api } from '../api-client';
import { sampleMergeContext } from './sample-context';

// =====================================================================
// shared types
// =====================================================================

export type BlockMode = 'editor-preview' | 'portal';

export interface BlockTypeDef {
  type: string;
  label: string;
  icon: string;
  defaultProps: () => Record<string, unknown>;
  EditorFields: (props: {
    block: ProposalBlock;
    onChange: (next: Partial<Omit<ProposalBlock, 'id'>>) => void;
  }) => JSX.Element;
  Renderer: (props: { block: ProposalBlock; mode?: BlockMode }) => JSX.Element;
}

// =====================================================================
// markdown — the workhorse text block (with merge token resolution)
// =====================================================================

const MARKDOWN: BlockTypeDef = {
  type: 'markdown',
  label: 'Markdown text',
  icon: '¶',
  defaultProps: () => ({ md: '' }),
  EditorFields: ({ block, onChange }) => (
    <div style={{ display: 'grid', gap: 6 }}>
      <textarea
        value={String(block.props['md'] ?? '')}
        onChange={(e) => onChange({ props: { ...block.props, md: e.target.value } })}
        rows={8}
        style={{
          fontFamily: 'ui-monospace, monospace',
          fontSize: 12,
          padding: 10,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          background: tokens.color.surface,
          color: tokens.color.text,
          width: '100%',
          resize: 'vertical',
        }}
        placeholder="Markdown body. Use {{ client.name }}, {{ firm.name }}, {{ today }} etc."
      />
      <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
        Merge tokens resolve at send time. Preview uses sample data.
      </div>
    </div>
  ),
  Renderer: ({ block }) => {
    const ctx = sampleMergeContext();
    const md = String(block.props['md'] ?? '');
    const { output } = resolveMergeTokens(md, ctx);
    return <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{output}</p>;
  },
};

// =====================================================================
// heading
// =====================================================================

const HEADING: BlockTypeDef = {
  type: 'heading',
  label: 'Heading',
  icon: 'H',
  defaultProps: () => ({ text: '', level: 1 }),
  EditorFields: ({ block, onChange }) => (
    <div style={{ display: 'grid', gap: 8 }}>
      <Input
        value={String(block.props['text'] ?? '')}
        onChange={(e) => onChange({ props: { ...block.props, text: e.target.value } })}
        placeholder="Heading text"
      />
      <div style={{ display: 'flex', gap: 4 }}>
        {[1, 2, 3].map((lvl) => (
          <button
            key={lvl}
            type="button"
            onClick={() => onChange({ props: { ...block.props, level: lvl } })}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              borderRadius: tokens.radius.sm,
              border: `1px solid ${
                Number(block.props['level']) === lvl ? tokens.color.accent : tokens.color.border
              }`,
              background:
                Number(block.props['level']) === lvl
                  ? tokens.color.accentMuted
                  : tokens.color.surface,
              color: Number(block.props['level']) === lvl ? tokens.color.accent : tokens.color.text,
              cursor: 'pointer',
            }}
          >
            H{lvl}
          </button>
        ))}
      </div>
    </div>
  ),
  Renderer: ({ block }) => {
    const text = String(block.props['text'] ?? '');
    const level = Number(block.props['level'] ?? 1);
    const sizes: Record<number, string> = { 1: '26px', 2: '20px', 3: '16px' };
    return (
      <div
        style={{ fontSize: sizes[level] ?? '16px', fontWeight: 700, margin: 0 }}
        aria-level={level}
        role="heading"
      >
        {text || <span style={{ color: tokens.color.textMuted }}>(empty heading)</span>}
      </div>
    );
  },
};

// =====================================================================
// divider
// =====================================================================

const DIVIDER: BlockTypeDef = {
  type: 'divider',
  label: 'Divider',
  icon: '─',
  defaultProps: () => ({}),
  EditorFields: () => (
    <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
      Horizontal divider. No props to configure.
    </p>
  ),
  Renderer: () => (
    <hr
      style={{
        border: 0,
        borderTop: `1px solid ${tokens.color.border}`,
        margin: '8px 0',
        width: '100%',
      }}
    />
  ),
};

// =====================================================================
// cover/intro
// =====================================================================
//
// v1 image is by URL — file upload waits for the MinIO sidecar (P13).
// Once that lands, the EditorFields swaps the URL inputs for an
// uploader.

const COVER: BlockTypeDef = {
  type: 'cover',
  label: 'Cover',
  icon: '★',
  defaultProps: () => ({
    title: '',
    subtitle: '',
    heroImageUrl: '',
    firmLogoUrl: '',
  }),
  EditorFields: ({ block, onChange }) => (
    <div style={{ display: 'grid', gap: 8 }}>
      <Input
        value={String(block.props['title'] ?? '')}
        onChange={(e) => onChange({ props: { ...block.props, title: e.target.value } })}
        placeholder="Title (e.g. Annual Tax + Bookkeeping 2026)"
      />
      <Input
        value={String(block.props['subtitle'] ?? '')}
        onChange={(e) => onChange({ props: { ...block.props, subtitle: e.target.value } })}
        placeholder="Subtitle"
      />
      <Input
        value={String(block.props['heroImageUrl'] ?? '')}
        onChange={(e) => onChange({ props: { ...block.props, heroImageUrl: e.target.value } })}
        placeholder="Hero image URL (file upload arrives in P13)"
      />
      <Input
        value={String(block.props['firmLogoUrl'] ?? '')}
        onChange={(e) => onChange({ props: { ...block.props, firmLogoUrl: e.target.value } })}
        placeholder="Firm logo URL"
      />
    </div>
  ),
  Renderer: ({ block }) => {
    const ctx = sampleMergeContext();
    const title = resolveMergeTokens(String(block.props['title'] ?? ''), ctx).output;
    const subtitle = resolveMergeTokens(String(block.props['subtitle'] ?? ''), ctx).output;
    const hero = String(block.props['heroImageUrl'] ?? '');
    const logo = String(block.props['firmLogoUrl'] ?? '');
    return (
      <div
        style={{
          padding: tokens.space.lg,
          background: tokens.color.bg,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.md,
          textAlign: 'center',
          display: 'grid',
          gap: 8,
        }}
      >
        {logo && (
          <img
            src={logo}
            alt="Firm logo"
            style={{ maxHeight: 48, margin: '0 auto', objectFit: 'contain' }}
          />
        )}
        {hero && (
          <img
            src={hero}
            alt={title || 'Cover image'}
            style={{ maxWidth: '100%', maxHeight: 220, borderRadius: tokens.radius.sm }}
          />
        )}
        <div style={{ fontSize: 28, fontWeight: 700 }}>
          {title || <span style={{ color: tokens.color.textMuted }}>(title)</span>}
        </div>
        {subtitle && <div style={{ fontSize: 14, color: tokens.color.textMuted }}>{subtitle}</div>}
      </div>
    );
  },
};

// =====================================================================
// video — YouTube / Vimeo / Loom
// =====================================================================

const VIDEO: BlockTypeDef = {
  type: 'video',
  label: 'Video',
  icon: '▶',
  defaultProps: () => ({ url: '', caption: '' }),
  EditorFields: ({ block, onChange }) => {
    const parsed = parseVideoUrl(String(block.props['url'] ?? ''));
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <Input
          value={String(block.props['url'] ?? '')}
          onChange={(e) => onChange({ props: { ...block.props, url: e.target.value } })}
          placeholder="YouTube / Vimeo / Loom URL"
        />
        <Input
          value={String(block.props['caption'] ?? '')}
          onChange={(e) => onChange({ props: { ...block.props, caption: e.target.value } })}
          placeholder="Caption (optional)"
        />
        {Boolean(block.props['url']) && !parsed && (
          <div style={{ fontSize: 12, color: tokens.color.danger }}>
            URL not recognized — must be YouTube, Vimeo, or Loom.
          </div>
        )}
        {parsed && (
          <div style={{ fontSize: 11, color: tokens.color.textMuted }}>
            <Pill>{parsed.provider}</Pill> id {parsed.videoId}
          </div>
        )}
      </div>
    );
  },
  Renderer: ({ block }) => {
    const parsed = parseVideoUrl(String(block.props['url'] ?? ''));
    const caption = String(block.props['caption'] ?? '');
    if (!parsed) {
      return (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          (Video placeholder — add a YouTube, Vimeo, or Loom URL)
        </p>
      );
    }
    return (
      <div style={{ display: 'grid', gap: 4 }}>
        <div style={{ position: 'relative', paddingTop: '56.25%' }}>
          <iframe
            src={parsed.embedUrl}
            title={caption || 'Embedded video'}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              border: 0,
              borderRadius: tokens.radius.sm,
            }}
          />
        </div>
        {caption && (
          <div style={{ fontSize: 12, color: tokens.color.textMuted, textAlign: 'center' }}>
            {caption}
          </div>
        )}
      </div>
    );
  },
};

// =====================================================================
// services list
// =====================================================================
//
// Stores serviceIds[] only — names + prices fetched at render time
// from /api/staff/services (no DB-fanout in saved JSON; the tree stays
// portable and the renderer always shows current catalog data until
// the proposal is sent + snapshotted in P06).

const SERVICES_LIST: BlockTypeDef = {
  type: 'services_list',
  label: 'Services list',
  icon: '☰',
  defaultProps: () => ({ serviceIds: [], showPrices: true }),
  EditorFields: ({ block, onChange }) => {
    const selected = (block.props['serviceIds'] as string[] | undefined) ?? [];
    const showPrices = Boolean(block.props['showPrices'] ?? true);
    const [services, setServices] = useState<
      { id: string; name: string; category: string; defaultPriceCents: number }[]
    >([]);
    useEffect(() => {
      void (async () => {
        try {
          const r = await api<{
            items: { id: string; name: string; category: string; defaultPriceCents: number }[];
          }>('/api/staff/services');
          setServices(r.items ?? []);
        } catch {
          setServices([]);
        }
      })();
    }, []);

    function toggle(id: string): void {
      const next = selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
      onChange({ props: { ...block.props, serviceIds: next } });
    }

    return (
      <div style={{ display: 'grid', gap: 8 }}>
        <label style={{ fontSize: 12, color: tokens.color.textMuted }}>
          <input
            type="checkbox"
            checked={showPrices}
            onChange={(e) => onChange({ props: { ...block.props, showPrices: e.target.checked } })}
            style={{ marginRight: 6 }}
          />
          Show prices in the rendered list
        </label>
        {services.length === 0 ? (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            No services in your catalog yet. Create some in Admin → Catalog → Services catalog.
          </p>
        ) : (
          <div
            style={{
              display: 'grid',
              gap: 4,
              maxHeight: 240,
              overflowY: 'auto',
              padding: 6,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
            }}
          >
            {services.map((s) => (
              <label key={s.id} style={{ fontSize: 13, display: 'flex', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={selected.includes(s.id)}
                  onChange={() => toggle(s.id)}
                />
                <span style={{ flex: 1 }}>{s.name}</span>
                <span style={{ color: tokens.color.textMuted, fontSize: 11 }}>{s.category}</span>
                <span style={{ color: tokens.color.textMuted, fontSize: 11 }}>
                  ${(Number(s.defaultPriceCents) / 100).toFixed(0)}
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    );
  },
  Renderer: ({ block }) => {
    const ids = (block.props['serviceIds'] as string[] | undefined) ?? [];
    const showPrices = Boolean(block.props['showPrices'] ?? true);
    const [services, setServices] = useState<
      { id: string; name: string; defaultPriceCents: number }[] | null
    >(null);
    useEffect(() => {
      void (async () => {
        try {
          const r = await api<{ items: { id: string; name: string; defaultPriceCents: number }[] }>(
            '/api/staff/services',
          );
          setServices(r.items ?? []);
        } catch {
          setServices([]);
        }
      })();
    }, []);
    if (ids.length === 0) {
      return (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          (No services selected for this block.)
        </p>
      );
    }
    if (services === null) {
      return <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>;
    }
    const items = ids.map((id) => services.find((s) => s.id === id)).filter(Boolean) as {
      id: string;
      name: string;
      defaultPriceCents: number;
    }[];
    return (
      <ul style={{ listStyle: 'disc', paddingLeft: 20, margin: 0 }}>
        {items.map((s) => (
          <li key={s.id} style={{ fontSize: 14, margin: '4px 0' }}>
            {s.name}
            {showPrices && (
              <span style={{ color: tokens.color.textMuted, marginLeft: 6, fontSize: 12 }}>
                — ${(Number(s.defaultPriceCents) / 100).toFixed(0)}
              </span>
            )}
          </li>
        ))}
      </ul>
    );
  },
};

// =====================================================================
// package selector
// =====================================================================
//
// Stores one packageName so the renderer can group tiers under that
// name (matches the same convention as /admin/packages). The client
// portal renders a 3-column tier picker; the firm-preview renders a
// summary card with each tier's total.

const PACKAGE_SELECTOR: BlockTypeDef = {
  type: 'package_selector',
  label: 'Package selector',
  icon: '⬓',
  defaultProps: () => ({ packageName: '' }),
  EditorFields: ({ block, onChange }) => {
    const [names, setNames] = useState<string[]>([]);
    useEffect(() => {
      void (async () => {
        try {
          const r = await api<{ groups: Record<string, unknown> }>(
            '/api/staff/packages?groupByName=true',
          );
          setNames(Object.keys(r.groups ?? {}));
        } catch {
          setNames([]);
        }
      })();
    }, []);
    const value = String(block.props['packageName'] ?? '');
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {names.length === 0 ? (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            No packages in your library yet. Build one in Admin → Catalog → Packages.
          </p>
        ) : (
          <div style={{ display: 'grid', gap: 4 }}>
            {names.map((n) => (
              <label key={n} style={{ fontSize: 13 }}>
                <input
                  type="radio"
                  name={`pkg-${block.id}`}
                  checked={value === n}
                  onChange={() => onChange({ props: { ...block.props, packageName: n } })}
                  style={{ marginRight: 6 }}
                />
                {n}
              </label>
            ))}
          </div>
        )}
      </div>
    );
  },
  Renderer: ({ block }) => {
    const name = String(block.props['packageName'] ?? '');
    const [tiers, setTiers] = useState<
      { tierLabel: string; totalIncludedCents: number; includedServiceCount: number }[] | null
    >(null);
    useEffect(() => {
      if (!name) {
        setTiers([]);
        return;
      }
      void (async () => {
        try {
          const r = await api<{
            groups: Record<
              string,
              { tierLabel: string; totalIncludedCents: number; includedServiceCount: number }[]
            >;
          }>('/api/staff/packages?groupByName=true');
          setTiers(r.groups[name] ?? []);
        } catch {
          setTiers([]);
        }
      })();
    }, [name]);
    if (!name) {
      return (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          (No package selected.)
        </p>
      );
    }
    if (tiers === null) {
      return <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>;
    }
    if (tiers.length === 0) {
      return (
        <p style={{ fontSize: 12, color: tokens.color.danger, margin: 0 }}>
          Package &quot;{name}&quot; not found.
        </p>
      );
    }
    return (
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>{name}</div>
        <div
          style={{
            display: 'grid',
            gap: 8,
            gridTemplateColumns: `repeat(${Math.min(tiers.length, 3)}, 1fr)`,
          }}
        >
          {tiers.map((t) => (
            <div
              key={t.tierLabel}
              style={{
                padding: tokens.space.md,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm,
                background: tokens.color.surface,
              }}
            >
              <div style={{ fontWeight: 600 }}>{t.tierLabel}</div>
              <div style={{ fontSize: 22, fontWeight: 700, margin: '4px 0' }}>
                ${(Number(t.totalIncludedCents) / 100).toFixed(0)}
              </div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted }}>
                {t.includedServiceCount} included
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  },
};

// =====================================================================
// terms — bound to a terms_template_id
// =====================================================================

const TERMS: BlockTypeDef = {
  type: 'terms',
  label: 'Terms',
  icon: '§',
  defaultProps: () => ({ termsTemplateId: '' }),
  EditorFields: ({ block, onChange }) => {
    const [items, setItems] = useState<
      { id: string; name: string; category: string; version: number }[]
    >([]);
    useEffect(() => {
      void (async () => {
        try {
          const r = await api<{
            items: { id: string; name: string; category: string; version: number }[];
          }>('/api/staff/terms-templates');
          setItems(r.items ?? []);
        } catch {
          setItems([]);
        }
      })();
    }, []);
    const value = String(block.props['termsTemplateId'] ?? '');
    return (
      <div style={{ display: 'grid', gap: 8 }}>
        {items.length === 0 ? (
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
            No terms templates yet. Create one in Admin → Catalog → Terms templates (or click
            &quot;Seed 6 starters&quot;).
          </p>
        ) : (
          <select
            value={value}
            onChange={(e) =>
              onChange({ props: { ...block.props, termsTemplateId: e.target.value } })
            }
            style={{
              padding: 6,
              fontSize: 13,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
              color: tokens.color.text,
            }}
          >
            <option value="">— pick a terms template —</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                [{i.category}] {i.name} (v{i.version})
              </option>
            ))}
          </select>
        )}
      </div>
    );
  },
  Renderer: ({ block }) => {
    const id = String(block.props['termsTemplateId'] ?? '');
    const [body, setBody] = useState<string | null>(null);
    useEffect(() => {
      if (!id) {
        setBody(null);
        return;
      }
      void (async () => {
        try {
          const r = await api<{ output: string }>(`/api/staff/terms-templates/${id}/preview`, {
            method: 'POST',
            body: JSON.stringify({ context: sampleMergeContext() }),
          });
          setBody(r.output);
        } catch {
          setBody('(failed to load terms)');
        }
      })();
    }, [id]);
    if (!id) {
      return (
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          (No terms template selected.)
        </p>
      );
    }
    if (body === null) {
      return <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>Loading…</p>;
    }
    return (
      <pre
        style={{
          fontFamily: 'inherit',
          fontSize: 13,
          whiteSpace: 'pre-wrap',
          background: tokens.color.bg,
          padding: tokens.space.md,
          borderRadius: tokens.radius.sm,
          border: `1px solid ${tokens.color.border}`,
          margin: 0,
        }}
      >
        {body}
      </pre>
    );
  },
};

// =====================================================================
// signature — preview placeholder
// =====================================================================
//
// The block stores label + the acceptance copy. The actual signing
// flow (typed-name pad, checkbox, payment-method trigger) is the
// portal's responsibility — implemented in P21. Editor preview shows
// the visual hook so the firm can verify where it sits in the
// document.

const SIGNATURE: BlockTypeDef = {
  type: 'signature',
  label: 'Signature',
  icon: '✎',
  defaultProps: () => ({
    label: 'Type your full legal name to sign',
    acceptanceCopy: 'I have read and agree to the terms of this engagement letter.',
  }),
  EditorFields: ({ block, onChange }) => (
    <div style={{ display: 'grid', gap: 8 }}>
      <Input
        value={String(block.props['label'] ?? '')}
        onChange={(e) => onChange({ props: { ...block.props, label: e.target.value } })}
        placeholder="Field label"
      />
      <textarea
        value={String(block.props['acceptanceCopy'] ?? '')}
        onChange={(e) => onChange({ props: { ...block.props, acceptanceCopy: e.target.value } })}
        rows={3}
        style={{
          fontFamily: 'inherit',
          fontSize: 12,
          padding: 10,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: tokens.radius.sm,
          background: tokens.color.surface,
          color: tokens.color.text,
          width: '100%',
          resize: 'vertical',
        }}
        placeholder="Acceptance copy shown next to the checkbox"
      />
      <p style={{ fontSize: 11, color: tokens.color.textMuted, margin: 0 }}>
        Portal signing UI + payment authorization is wired up in the acceptance flow (P21).
      </p>
    </div>
  ),
  Renderer: ({ block }) => (
    <Card>
      <div style={{ display: 'grid', gap: 8 }}>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          {String(block.props['acceptanceCopy'] ?? '')}
        </p>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
          <input type="checkbox" disabled />
          <span>{String(block.props['acceptanceCopy'] ?? '')}</span>
        </label>
        <div style={{ display: 'grid', gap: 4 }}>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
            {String(block.props['label'] ?? '')}
          </span>
          <Input value="" onChange={() => undefined} disabled placeholder="(client signs here)" />
        </div>
        <Button size="sm" disabled>
          Sign + authorize payment
        </Button>
      </div>
    </Card>
  ),
};

// =====================================================================
// Registry + ordering for the palette
// =====================================================================

const ALL_DEFS: BlockTypeDef[] = [
  COVER,
  MARKDOWN,
  HEADING,
  DIVIDER,
  VIDEO,
  SERVICES_LIST,
  PACKAGE_SELECTOR,
  TERMS,
  SIGNATURE,
];

export const REGISTRY: ReadonlyMap<string, BlockTypeDef> = new Map(
  ALL_DEFS.map((d) => [d.type, d]),
);

// Palette order. Cover stays at the top (most proposals open with it);
// signature stays at the bottom (most close with it).
export const PALETTE_ORDER: BlockTypeDef[] = ALL_DEFS;

export function getBlockDef(type: string): BlockTypeDef | undefined {
  return REGISTRY.get(type);
}
