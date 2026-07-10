// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Server-side brochure hydration for the client portal: resolves service
// names/prices, package tiers (with override precedence + description
// fallback), terms content, and {{ merge tokens }} against the real client.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { packages, packageServices, servicesCatalog, termsTemplates } from '@vibe/db/schema';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { hydrateBrochureForPortal } from '../proposals/portal-hydrate';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

interface HydratedBlock {
  type: string;
  props: Record<string, unknown>;
}

describe('hydrateBrochureForPortal', () => {
  it('resolves services, package tiers, terms, and merge tokens', async () => {
    // A catalog service.
    const [svc] = await harness.db
      .insert(servicesCatalog)
      .values({
        firmId: seed.firmId,
        name: 'Tax Prep',
        category: 'TAX',
        defaultPriceCents: 50000,
      })
      .returning({ id: servicesCatalog.id });

    // A package tier with a flat price override + a description, including svc.
    const [pkg] = await harness.db
      .insert(packages)
      .values({
        firmId: seed.firmId,
        name: 'Gold Pack',
        tierLabel: 'Gold',
        position: 0,
        description: 'Master description',
        priceOverrideCents: 500000,
      })
      .returning({ id: packages.id });
    await harness.db
      .insert(packageServices)
      .values({ packageId: pkg!.id, serviceId: svc!.id, included: true, sequence: 0 });

    const brochure = {
      schemaVersion: 1,
      blocks: [
        { id: 'b1', type: 'markdown', position: 0, props: { md: 'Hello {{ client.name }}' } },
        {
          id: 'b2',
          type: 'services_list',
          position: 1,
          props: {
            serviceIds: [svc!.id],
            showPrices: true,
            priceOverridesCents: { [svc!.id]: 99900 },
          },
        },
        {
          id: 'b3',
          type: 'package_selector',
          position: 2,
          props: {
            packageName: 'Gold Pack',
            tierOverridesCents: {},
            tierDescriptions: { Gold: 'Best **value**' },
          },
        },
        {
          id: 'b4',
          type: 'terms',
          position: 3,
          props: { contentMd: 'Terms for {{ client.name }}' },
        },
      ],
    };

    const out = await hydrateBrochureForPortal(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      brochureJsonb: brochure,
    });
    const blocks = out.blocks as unknown as HydratedBlock[];

    // markdown merge token resolved to the seeded client name.
    expect(blocks[0]!.props['md']).toBe('Hello Test Client Co');

    // services_list resolved name + override price.
    const items = blocks[1]!.props['items'] as { name: string; priceCents: number }[];
    expect(items).toEqual([{ name: 'Tax Prep', priceCents: 99900 }]);

    // package tier: price = package override (no tier override), description from
    // the per-proposal override, includedServiceCount counted.
    const tiers = blocks[2]!.props['tiers'] as {
      tierLabel: string;
      priceCents: number;
      description: string;
      includedServiceCount: number;
    }[];
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toMatchObject({
      tierLabel: 'Gold',
      priceCents: 500000,
      description: 'Best **value**',
      includedServiceCount: 1,
    });

    // terms merge token resolved.
    expect(blocks[3]!.props['contentMd']).toBe('Terms for Test Client Co');
  });

  it('tier override beats package override; loads terms from template when no inline content', async () => {
    const [pkg] = await harness.db
      .insert(packages)
      .values({
        firmId: seed.firmId,
        name: 'Plan',
        tierLabel: 'Std',
        position: 0,
        description: 'desc',
        priceOverrideCents: 100000,
      })
      .returning({ id: packages.id });
    void pkg;
    const [tpl] = await harness.db
      .insert(termsTemplates)
      .values({ firmId: seed.firmId, category: 'TAX', name: 'T', contentMd: '# Heading\nbody' })
      .returning({ id: termsTemplates.id });

    const brochure = {
      schemaVersion: 1,
      blocks: [
        {
          id: 'p',
          type: 'package_selector',
          position: 0,
          props: { packageName: 'Plan', tierOverridesCents: { Std: 250000 }, tierDescriptions: {} },
        },
        { id: 't', type: 'terms', position: 1, props: { termsTemplateId: tpl!.id, contentMd: '' } },
      ],
    };
    const out = await hydrateBrochureForPortal(harness.db, {
      firmId: seed.firmId,
      clientId: seed.clientId,
      brochureJsonb: brochure,
    });
    const blocks = out.blocks as unknown as HydratedBlock[];
    const tiers = blocks[0]!.props['tiers'] as { priceCents: number; description: string }[];
    expect(tiers[0]!.priceCents).toBe(250000); // tier override wins
    expect(tiers[0]!.description).toBe('desc'); // falls back to master
    expect(blocks[1]!.props['contentMd']).toBe('# Heading\nbody'); // loaded from template
  });
});
