// SPDX-License-Identifier: Elastic-2.0
import { describe, it, expect, beforeEach } from 'vitest';

import { loadConfig, resetConfigForTests } from '../config';

describe('loadConfig', () => {
  beforeEach(() => {
    resetConfigForTests();
  });

  it('rejects identical staff and portal JWT secrets', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://x',
        STAFF_JWT_SECRET: 'same-secret-1234567890',
        PORTAL_JWT_SECRET: 'same-secret-1234567890',
      } as NodeJS.ProcessEnv),
    ).toThrow(/cross-realm/i);
  });

  it('accepts dev defaults when secrets are missing in non-prod', () => {
    const cfg = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(cfg.STAFF_JWT_SECRET).not.toBe(cfg.PORTAL_JWT_SECRET);
    expect(cfg.STEP_UP_TIMEOUT_MINUTES).toBe(30);
  });

  it('fails in production when DATABASE_URL is missing', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        STAFF_JWT_SECRET: 'staff-secret-1234567890',
        PORTAL_JWT_SECRET: 'portal-secret-1234567890',
      } as NodeJS.ProcessEnv),
    ).toThrow(/DATABASE_URL/);
  });
});
