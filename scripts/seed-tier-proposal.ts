// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Seed a single SENT proposal that offers a real multi-tier package, so the
// end-to-end tier-selection feature can be verified in the UI:
//   - staff editor shows the offered tiers + (after accept) the chosen one
//   - the portal magic link renders selectable tier cards
//
// A "tier" is a packages row; tiers of one package share a name and differ by
// tier_label. The package_selector block references that shared name. This
// script creates a clean "Tier Test — Annual Package" (Bronze/Silver/Gold)
// because the bulk demo seed models its three-tier packs as distinct names per
// tier (which therefore won't group as tiers under one name).
//
// Idempotent: clears its own prior package + proposal (by marker) first.
// Run with DATABASE_URL + FIRM_ID env vars.

import { createHash, randomBytes } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';

import { createDb } from '@vibe/db';
import {
  appUsers,
  clients,
  magicLinks,
  packageServices,
  packages,
  proposalPackages,
  proposalVersions,
  proposals,
  servicesCatalog,
} from '@vibe/db/schema';

const PACKAGE_NAME = 'Tier Test — Annual Package';
const PROPOSAL_TITLE = 'Tier Test Proposal (selectable tiers)';

const TIERS = [
  {
    tierLabel: 'Bronze',
    position: 0,
    priceOverrideCents: 60000,
    description: 'Essentials — annual return + e-file.',
    serviceCount: 1,
  },
  {
    tierLabel: 'Silver',
    position: 1,
    priceOverrideCents: 150000,
    description: 'Everything in Bronze **plus** quarterly check-ins.',
    serviceCount: 2,
  },
  {
    tierLabel: 'Gold',
    position: 2,
    priceOverrideCents: 300000,
    description: 'Full-service: Silver **plus** proactive advisory.',
    serviceCount: 3,
  },
];

function brochure(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    blocks: [
      {
        id: 'cover',
        type: 'cover',
        position: 0,
        props: { title: 'Engagement Proposal', subtitle: 'Prepared for {{ client.name }}' },
      },
      {
        id: 'intro',
        type: 'markdown',
        position: 1,
        props: {
          md: 'Thank you for considering **{{ firm.name }}**. Please choose the service tier that best fits your needs below.',
        },
      },
      {
        id: 'pkg',
        type: 'package_selector',
        position: 2,
        props: {
          packageName: PACKAGE_NAME,
          tierOverridesCents: {},
          tierDescriptions: Object.fromEntries(TIERS.map((t) => [t.tierLabel, t.description])),
        },
      },
      {
        id: 'terms',
        type: 'terms',
        position: 3,
        props: {
          contentMd:
            '## Terms\nThis engagement is governed by our standard terms. Fees are billed per the selected tier.',
        },
      },
      { id: 'sig', type: 'signature', position: 4, props: {} },
    ],
  };
}

async function main(): Promise<void> {
  const connectionString = process.env['DATABASE_URL'];
  const firmId = process.env['FIRM_ID'];
  if (!connectionString || !firmId) throw new Error('DATABASE_URL and FIRM_ID are required');
  const portalBase = process.env['PORTAL_BASE_URL'] ?? 'https://portal.vcpa.app';
  const appBase = process.env['APP_BASE_URL'] ?? 'https://practice.vcpa.app';

  const { db, close } = createDb({ connectionString });
  try {
    // Resolve a partner (creator) + a client.
    const [creator] = await db
      .select({ id: appUsers.id, name: appUsers.fullName })
      .from(appUsers)
      .where(eq(appUsers.firmId, firmId))
      .limit(1);
    if (!creator) throw new Error('no app_user found for firm');
    const [client] = await db
      .select({ id: clients.id, name: clients.name })
      .from(clients)
      .where(eq(clients.firmId, firmId))
      .orderBy(asc(clients.name))
      .limit(1);
    if (!client) throw new Error('no client found for firm');

    // Three catalog services to include across the tiers (reuse existing ones).
    const svcRows = await db
      .select({ id: servicesCatalog.id, name: servicesCatalog.name })
      .from(servicesCatalog)
      .where(eq(servicesCatalog.firmId, firmId))
      .orderBy(asc(servicesCatalog.name))
      .limit(3);
    if (svcRows.length < 3) throw new Error('need at least 3 services in the catalog');

    // --- Idempotency: clear prior run's proposal + package. ---
    const priorProps = await db
      .select({ id: proposals.id })
      .from(proposals)
      .where(and(eq(proposals.firmId, firmId), eq(proposals.title, PROPOSAL_TITLE)));
    for (const p of priorProps) {
      // magic_links.proposal_id has ON DELETE SET NULL; remove them explicitly.
      await db.delete(magicLinks).where(eq(magicLinks.proposalId, p.id));
      await db.delete(proposals).where(eq(proposals.id, p.id)); // cascades versions/packages/activity
    }
    const priorPkgs = await db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.firmId, firmId), eq(packages.name, PACKAGE_NAME)));
    if (priorPkgs.length > 0) {
      await db.delete(packages).where(
        inArray(
          packages.id,
          priorPkgs.map((p) => p.id),
        ),
      ); // cascades package_services
    }

    // --- Create the multi-tier package. ---
    const pkgIds: string[] = [];
    for (const t of TIERS) {
      const [pkg] = await db
        .insert(packages)
        .values({
          firmId,
          name: PACKAGE_NAME,
          tierLabel: t.tierLabel,
          position: t.position,
          description: t.description,
          priceOverrideCents: t.priceOverrideCents,
          createdById: creator.id,
        })
        .returning({ id: packages.id });
      pkgIds.push(pkg!.id);
      // Include the first N services in this tier.
      await db.insert(packageServices).values(
        svcRows.slice(0, t.serviceCount).map((s, i) => ({
          packageId: pkg!.id,
          serviceId: s.id,
          included: true,
          sequence: i,
        })),
      );
    }

    // --- Create the SENT proposal (mirrors the /send flow). ---
    const now = new Date();
    const [proposal] = await db
      .insert(proposals)
      .values({
        firmId,
        clientId: client.id,
        status: 'SENT',
        title: PROPOSAL_TITLE,
        brochureJsonb: brochure() as unknown as Record<string, unknown>,
        totalOneTimeCents: 0,
        totalRecurringCents: 0,
        sentAt: now,
        createdById: creator.id,
      })
      .returning({ id: proposals.id });
    const proposalId = proposal!.id;

    // v1 SENT snapshot.
    await db.insert(proposalVersions).values({
      proposalId,
      version: 1,
      contentJsonb: { title: PROPOSAL_TITLE, brochureJsonb: brochure() } as unknown as Record<
        string,
        unknown
      >,
      contentHash: createHash('sha256').update(`${proposalId}:v1`).digest('hex'),
      reason: 'SENT',
      createdById: creator.id,
    });

    // Offered tiers snapshot (one proposal_packages row per tier).
    await db.insert(proposalPackages).values(
      pkgIds.map((id, i) => ({
        proposalId,
        packageId: id,
        sequence: i,
      })),
    );

    // --- Portal magic link (raw token shown once). ---
    const raw = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(raw).digest('hex');
    await db.insert(magicLinks).values({
      firmId,
      tokenHash,
      purpose: 'PROPOSAL',
      clientId: client.id,
      proposalId,
      expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    });

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          ok: true,
          proposalId,
          client: client.name,
          createdBy: creator.name,
          tiers: TIERS.map((t, i) => ({
            tierLabel: t.tierLabel,
            packageId: pkgIds[i],
            priceCents: t.priceOverrideCents,
          })),
          staffEditorUrl: `${appBase}/proposals/${proposalId}`,
          portalUrl: `${portalBase}/p/${raw}`,
        },
        null,
        2,
      ),
    );
  } finally {
    await close();
  }
}

void main().then(
  () => process.exit(0),
  (err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  },
);
