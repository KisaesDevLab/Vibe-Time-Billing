// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Server-side hydration of a proposal brochure for the client portal. The
// portal cannot call the staff catalog APIs, so we resolve each block into
// self-contained render props here (service names/prices, package tiers, terms
// content) and resolve {{ merge tokens }} against the real client/firm. The
// portal renderer then draws the full block set without any catalog fetch.
//
// Live-at-view-time: prices/terms reflect the current catalog + per-proposal
// overrides when the client opens the proposal.

import { and, eq, inArray } from 'drizzle-orm';

import type { Database } from '@vibe/db';
import {
  clients,
  firms,
  packageServices,
  packages,
  servicesCatalog,
  termsTemplates,
} from '@vibe/db/schema';
import { resolveMergeTokens } from '@vibe/core/proposals';

interface RawBlock {
  id?: string;
  type: string;
  position?: number;
  props?: Record<string, unknown>;
}
interface RawBrochure {
  schemaVersion?: number;
  blocks?: RawBlock[];
  packages?: unknown[];
}

type MergeCtx = Parameters<typeof resolveMergeTokens>[1];

function num(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0);
}

async function buildMergeContext(
  db: Database,
  proposal: { firmId: string; clientId: string },
): Promise<MergeCtx> {
  const [client] = await db
    .select({ name: clients.name, externalId: clients.externalId })
    .from(clients)
    .where(eq(clients.id, proposal.clientId))
    .limit(1);
  const [firm] = await db
    .select({ name: firms.name })
    .from(firms)
    .where(eq(firms.id, proposal.firmId))
    .limit(1);
  return {
    client: { name: client?.name ?? '', legal_name: client?.name ?? '' },
    firm: { name: firm?.name ?? '', legal_name: firm?.name ?? '' },
    today: new Date().toISOString().slice(0, 10),
  } as MergeCtx;
}

function resolve(md: string, ctx: MergeCtx): string {
  if (!md) return md;
  try {
    return resolveMergeTokens(md, ctx).output;
  } catch {
    return md;
  }
}

async function hydrateServicesList(
  db: Database,
  firmId: string,
  props: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ids = Array.isArray(props['serviceIds']) ? (props['serviceIds'] as string[]) : [];
  const overrides = (props['priceOverridesCents'] as Record<string, number> | undefined) ?? {};
  if (ids.length === 0) return { showPrices: props['showPrices'] ?? true, items: [] };
  const rows = await db
    .select({
      id: servicesCatalog.id,
      name: servicesCatalog.name,
      defaultPriceCents: servicesCatalog.defaultPriceCents,
    })
    .from(servicesCatalog)
    .where(and(eq(servicesCatalog.firmId, firmId), inArray(servicesCatalog.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = ids
    .map((id) => {
      const r = byId.get(id);
      if (!r) return null;
      return { name: r.name, priceCents: overrides[id] ?? num(r.defaultPriceCents) };
    })
    .filter((x): x is { name: string; priceCents: number } => x !== null);
  return { showPrices: props['showPrices'] ?? true, items };
}

async function hydratePackageSelector(
  db: Database,
  firmId: string,
  props: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const name = String(props['packageName'] ?? '');
  const tierOverrides = (props['tierOverridesCents'] as Record<string, number> | undefined) ?? {};
  const tierDescriptions = (props['tierDescriptions'] as Record<string, string> | undefined) ?? {};
  if (!name) return { packageName: name, tiers: [] };

  const pkgRows = await db
    .select({
      id: packages.id,
      tierLabel: packages.tierLabel,
      position: packages.position,
      description: packages.description,
      priceOverrideCents: packages.priceOverrideCents,
    })
    .from(packages)
    .where(and(eq(packages.firmId, firmId), eq(packages.name, name)));
  if (pkgRows.length === 0) return { packageName: name, tiers: [] };

  // Sum of included service prices per package tier.
  const ids = pkgRows.map((p) => p.id);
  const joined = await db
    .select({
      packageId: packageServices.packageId,
      overridePriceCents: packageServices.overridePriceCents,
      defaultPriceCents: servicesCatalog.defaultPriceCents,
      included: packageServices.included,
    })
    .from(packageServices)
    .innerJoin(servicesCatalog, eq(servicesCatalog.id, packageServices.serviceId))
    .where(inArray(packageServices.packageId, ids));
  const sumByPkg = new Map<string, number>();
  const countByPkg = new Map<string, number>();
  for (const j of joined) {
    if (!j.included) continue;
    sumByPkg.set(
      j.packageId,
      (sumByPkg.get(j.packageId) ?? 0) + num(j.overridePriceCents ?? j.defaultPriceCents),
    );
    countByPkg.set(j.packageId, (countByPkg.get(j.packageId) ?? 0) + 1);
  }

  const tiers = pkgRows
    .sort((a, b) => a.position - b.position)
    .map((p) => {
      const sum = sumByPkg.get(p.id) ?? 0;
      const priceCents = tierOverrides[p.tierLabel] ?? p.priceOverrideCents ?? sum;
      return {
        tierLabel: p.tierLabel,
        priceCents: num(priceCents),
        description: tierDescriptions[p.tierLabel] ?? p.description ?? '',
        includedServiceCount: countByPkg.get(p.id) ?? 0,
      };
    });
  return { packageName: name, tiers };
}

async function hydrateTerms(
  db: Database,
  firmId: string,
  props: Record<string, unknown>,
  ctx: MergeCtx,
): Promise<Record<string, unknown>> {
  let md = String(props['contentMd'] ?? '');
  if (!md.trim()) {
    const id = String(props['termsTemplateId'] ?? '');
    if (id) {
      const [tpl] = await db
        .select({ contentMd: termsTemplates.contentMd })
        .from(termsTemplates)
        .where(and(eq(termsTemplates.id, id), eq(termsTemplates.firmId, firmId)))
        .limit(1);
      md = tpl?.contentMd ?? '';
    }
  }
  return { contentMd: resolve(md, ctx) };
}

/**
 * Resolve a proposal's brochure into self-contained, portal-renderable blocks.
 * Never throws: a block that fails to hydrate is passed through unchanged.
 */
export async function hydrateBrochureForPortal(
  db: Database,
  proposal: { firmId: string; clientId: string; brochureJsonb: unknown },
): Promise<RawBrochure> {
  const raw = (proposal.brochureJsonb ?? {}) as RawBrochure;
  const blocks = Array.isArray(raw.blocks) ? raw.blocks : [];
  const ctx = await buildMergeContext(db, proposal);

  const hydrated = await Promise.all(
    blocks.map(async (b) => {
      const props = (b.props ?? {}) as Record<string, unknown>;
      try {
        switch (b.type) {
          case 'markdown':
            return { ...b, props: { ...props, md: resolve(String(props['md'] ?? ''), ctx) } };
          case 'terms':
            return { ...b, props: await hydrateTerms(db, proposal.firmId, props, ctx) };
          case 'services_list':
            return { ...b, props: await hydrateServicesList(db, proposal.firmId, props) };
          case 'package_selector':
            return { ...b, props: await hydratePackageSelector(db, proposal.firmId, props) };
          case 'cover':
            return {
              ...b,
              props: {
                ...props,
                title: resolve(String(props['title'] ?? ''), ctx),
                subtitle: resolve(String(props['subtitle'] ?? ''), ctx),
              },
            };
          case 'heading':
            return { ...b, props: { ...props, text: resolve(String(props['text'] ?? ''), ctx) } };
          default:
            return b;
        }
      } catch {
        return b;
      }
    }),
  );

  return { schemaVersion: raw.schemaVersion ?? 1, blocks: hydrated };
}
