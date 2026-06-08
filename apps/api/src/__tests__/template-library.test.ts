// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Template-library import: clones shipped system defaults into the firm
// catalog with value mapping, idempotency, and per-tier package expansion.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type express from 'express';

import {
  clientTemplates,
  engagementLetterTemplates,
  engagementTemplates,
  notificationTemplates,
  packages,
  packageServices,
  requestTemplateItems,
  requestTemplates,
  servicesCatalog,
  termsTemplates,
} from '@vibe/db/schema';
import {
  SYSTEM_EMAIL_TEMPLATES,
  SYSTEM_ENGAGEMENT_TEMPLATES,
  SYSTEM_LETTER_TEMPLATES,
  SYSTEM_REQUEST_TEMPLATES,
  SYSTEM_SERVICE_TEMPLATES,
} from '@vibe/db/seed-helpers';
import type { RoleSlug } from '@vibe/core/rbac';

import { buildPgliteHarness, seedMinimalFirm, type PgliteHarness } from './_pglite-harness';
import { createTemplateLibraryRouter } from '../template-library/routes';

let harness: PgliteHarness;
let seed: Awaited<ReturnType<typeof seedMinimalFirm>>;

beforeEach(async () => {
  harness = await buildPgliteHarness();
  seed = await seedMinimalFirm(harness.db);
});
afterEach(async () => {
  await harness.close();
});

interface FakeRes {
  statusCode: number;
  jsonBody: unknown;
  status(c: number): FakeRes;
  json(b: unknown): FakeRes;
}
function makeRes(): FakeRes {
  return {
    statusCode: 200,
    jsonBody: undefined,
    status(c) {
      this.statusCode = c;
      return this;
    },
    json(b) {
      this.jsonBody = b;
      return this;
    },
  };
}

async function invoke(
  router: express.Router,
  method: 'get' | 'post',
  path: string,
  body?: unknown,
): Promise<FakeRes> {
  const res = makeRes();
  const reqObj: Record<string, unknown> = {
    body: body ?? {},
    params: {},
    query: {},
    headers: {},
    staffSession: { firmId: seed.firmId, appUserId: seed.appUserId },
    ip: '127.0.0.1',
    header: () => undefined,
    get: () => undefined,
  };
  const layer = router.stack.find((l) => {
    if (!l.route) return false;
    const r = l.route as unknown as { path: string; methods: Record<string, boolean> };
    return r.path === path && r.methods[method] === true;
  });
  if (!layer) throw new Error(`route not registered: ${method} ${path}`);
  const route = layer.route as unknown as { stack: { handle: (...a: unknown[]) => unknown }[] };
  const chain = route.stack;
  for (let i = 0; i < chain.length - 1; i++) {
    let advanced = false;
    await (chain[i]!.handle as (rq: unknown, rs: unknown, nx: () => void) => unknown)(
      reqObj,
      res,
      () => {
        advanced = true;
      },
    );
    if (!advanced) return res;
  }
  await (chain[chain.length - 1]!.handle as (rq: unknown, rs: unknown) => unknown)(reqObj, res);
  return res;
}

function router(roles: RoleSlug[] = ['admin']) {
  return createTemplateLibraryRouter({
    db: harness.db,
    fakeUserRoles: new Map([[seed.appUserId, roles]]),
  });
}

describe('template library import', () => {
  it('imports all services with mapped billing types + coa, idempotently', async () => {
    const r = router();
    const res = await invoke(r, 'post', '/services/import', {});
    expect(res.statusCode).toBe(200);
    const counts = res.jsonBody as { imported: number; skipped: number; total: number };
    expect(counts.imported).toBe(SYSTEM_SERVICE_TEMPLATES.length);
    expect(counts.skipped).toBe(0);

    const [oneTime] = await harness.db
      .select()
      .from(servicesCatalog)
      .where(
        and(
          eq(servicesCatalog.firmId, seed.firmId),
          eq(servicesCatalog.clonedFromSlug, 'individual-1040'),
        ),
      );
    expect(oneTime!.billingType).toBe('ONE_TIME');
    expect(oneTime!.recurringInterval).toBeNull();
    expect(oneTime!.coaCode).toBe('4100'); // TAX category default COA

    const [recurring] = await harness.db
      .select()
      .from(servicesCatalog)
      .where(
        and(
          eq(servicesCatalog.firmId, seed.firmId),
          eq(servicesCatalog.clonedFromSlug, 'monthly-bookkeeping-low-volume'),
        ),
      );
    expect(recurring!.billingType).toBe('RECURRING');
    expect(recurring!.recurringInterval).toBe('MONTHLY');

    // Re-import is a no-op.
    const again = (await invoke(r, 'post', '/services/import', {})).jsonBody as {
      imported: number;
      skipped: number;
    };
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(SYSTEM_SERVICE_TEMPLATES.length);
  });

  it('GET /services flags imported items', async () => {
    const r = router();
    await invoke(r, 'post', '/services/import', { slugs: ['individual-1040'] });
    const list = (await invoke(r, 'get', '/services')).jsonBody as {
      items: { slug: string; imported: boolean }[];
    };
    expect(list.items.length).toBe(SYSTEM_SERVICE_TEMPLATES.length);
    expect(list.items.find((i) => i.slug === 'individual-1040')!.imported).toBe(true);
    expect(list.items.filter((i) => i.imported).length).toBe(1);
  });

  it('imports a terms template into terms_templates', async () => {
    const r = router();
    const list = (await invoke(r, 'get', '/terms')).jsonBody as {
      items: { slug: string }[];
    };
    const slug = list.items[0]!.slug;
    const res = await invoke(r, 'post', '/terms/import', { slugs: [slug] });
    expect((res.jsonBody as { imported: number }).imported).toBe(1);
    const [row] = await harness.db
      .select()
      .from(termsTemplates)
      .where(and(eq(termsTemplates.firmId, seed.firmId), eq(termsTemplates.clonedFromSlug, slug)));
    expect(row!.contentMd.length).toBeGreaterThan(0);
    expect(row!.isDefault).toBe(false);
  });

  it('imports a package as one firm package per tier with linked services', async () => {
    const r = router();
    const res = await invoke(r, 'post', '/packages/import', { slugs: ['individual-tax-duo'] });
    const counts = res.jsonBody as { imported: number };
    expect(counts.imported).toBe(2); // core + plus tiers

    const pkgs = await harness.db.select().from(packages).where(eq(packages.firmId, seed.firmId));
    const slugs = pkgs.map((p) => p.clonedFromSlug).sort();
    expect(slugs).toEqual(['individual-tax-duo:core', 'individual-tax-duo:plus']);

    // Both tiers are rows of ONE package: same name, distinct tier_label
    // (so the package_selector groups them as selectable tiers).
    expect(new Set(pkgs.map((p) => p.name))).toEqual(
      new Set(['Individual Tax — Two-Tier Starter']),
    );
    expect(pkgs.map((p) => p.tierLabel).sort()).toEqual(['Core', 'Plus']);

    // Referenced services were auto-imported.
    const [svc] = await harness.db
      .select()
      .from(servicesCatalog)
      .where(
        and(
          eq(servicesCatalog.firmId, seed.firmId),
          eq(servicesCatalog.clonedFromSlug, 'individual-1040'),
        ),
      );
    expect(svc).toBeTruthy();

    // At least one package_services link exists.
    const links = await harness.db.select().from(packageServices);
    expect(links.length).toBeGreaterThan(0);

    // Re-import is a no-op.
    const again = (await invoke(r, 'post', '/packages/import', { slugs: ['individual-tax-duo'] }))
      .jsonBody as { imported: number; skipped: number };
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(2);
  });

  it('imports emails into notification_template (EMAIL), idempotently', async () => {
    const r = router();
    const res = await invoke(r, 'post', '/emails/import', {});
    expect((res.jsonBody as { imported: number }).imported).toBe(SYSTEM_EMAIL_TEMPLATES.length);
    const rows = await harness.db
      .select()
      .from(notificationTemplates)
      .where(
        and(
          eq(notificationTemplates.firmId, seed.firmId),
          eq(notificationTemplates.channel, 'EMAIL'),
        ),
      );
    expect(rows.length).toBe(SYSTEM_EMAIL_TEMPLATES.length);

    const again = (await invoke(r, 'post', '/emails/import', {})).jsonBody as {
      imported: number;
      skipped: number;
    };
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(SYSTEM_EMAIL_TEMPLATES.length);
  });

  it('imports engagement templates idempotently with mapped fee structure', async () => {
    const r = router();
    const res = await invoke(r, 'post', '/engagements/import', {});
    expect((res.jsonBody as { imported: number }).imported).toBe(
      SYSTEM_ENGAGEMENT_TEMPLATES.length,
    );
    const [row] = await harness.db
      .select()
      .from(engagementTemplates)
      .where(
        and(
          eq(engagementTemplates.firmId, seed.firmId),
          eq(engagementTemplates.clonedFromSlug, 'individual-1040'),
        ),
      );
    expect(row!.defaultFeeStructure).toBe('FIXED_FEE');
    expect(row!.key).toBe('individual-1040');
    expect(row!.namePattern).toContain('{{client.name}}');

    const again = (await invoke(r, 'post', '/engagements/import', {})).jsonBody as {
      imported: number;
      skipped: number;
    };
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(SYSTEM_ENGAGEMENT_TEMPLATES.length);
  });

  it('imports engagement letter templates', async () => {
    const r = router();
    const res = await invoke(r, 'post', '/letters/import', {});
    expect((res.jsonBody as { imported: number }).imported).toBe(SYSTEM_LETTER_TEMPLATES.length);
    const rows = await harness.db
      .select()
      .from(engagementLetterTemplates)
      .where(eq(engagementLetterTemplates.firmId, seed.firmId));
    expect(rows.length).toBe(SYSTEM_LETTER_TEMPLATES.length);
    expect(rows.every((x) => x.bodyHtml.length > 0)).toBe(true);
  });

  it('imports request templates with their checklist items', async () => {
    const r = router();
    const res = await invoke(r, 'post', '/requests/import', { slugs: ['individual-1040-docs'] });
    expect((res.jsonBody as { imported: number }).imported).toBe(1);
    const [tpl] = await harness.db
      .select()
      .from(requestTemplates)
      .where(
        and(
          eq(requestTemplates.firmId, seed.firmId),
          eq(requestTemplates.clonedFromSlug, 'individual-1040-docs'),
        ),
      );
    expect(tpl!.defaultPriority).toBe('HIGH');
    const itemRows = await harness.db
      .select()
      .from(requestTemplateItems)
      .where(eq(requestTemplateItems.templateId, tpl!.id));
    const expectedItems = SYSTEM_REQUEST_TEMPLATES.find((t) => t.slug === 'individual-1040-docs')!
      .items.length;
    expect(itemRows.length).toBe(expectedItems);
  });

  it('imports client templates and resolves their engagement slugs to ids', async () => {
    const r = router();
    const res = await invoke(r, 'post', '/clients/import', { slugs: ['scorp-client'] });
    expect((res.jsonBody as { imported: number }).imported).toBe(1);
    const [row] = await harness.db
      .select()
      .from(clientTemplates)
      .where(
        and(
          eq(clientTemplates.firmId, seed.firmId),
          eq(clientTemplates.clonedFromSlug, 'scorp-client'),
        ),
      );
    expect(row!.clientType).toBe('BUSINESS');
    // The two suggested engagement slugs were auto-imported and resolved.
    expect(row!.defaultEngagementTemplateIds.length).toBe(2);
    const engs = await harness.db
      .select()
      .from(engagementTemplates)
      .where(eq(engagementTemplates.firmId, seed.firmId));
    const engIds = new Set(engs.map((e) => e.id));
    expect(row!.defaultEngagementTemplateIds.every((id) => engIds.has(id))).toBe(true);
  });
});
