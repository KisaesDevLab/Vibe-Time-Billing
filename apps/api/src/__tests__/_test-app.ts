// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Test harness that builds an Express app backed by an in-memory ioredis
// double, so integration-shaped tests can exercise the auth flows without
// a real Redis or Postgres.

import RedisMock from 'ioredis-mock';
import type { Redis } from 'ioredis';

import { createApp, type AppDeps } from '../app';
import { createSessionStore } from '../auth/session-store';
import { resetConfigForTests } from '../config';

export interface TestHarness {
  app: ReturnType<typeof createApp>;
  redis: Redis;
  capturedMagicLinks: { email: string; firmId: string; link: string }[];
  capturedEmailOtps: { email: string; firmId: string; code: string }[];
  capturedSmsOtps: { phone: string; firmId: string; code: string }[];
}

export async function buildTestApp(overrides: Partial<AppDeps> = {}): Promise<TestHarness> {
  process.env['NODE_ENV'] = 'test';
  process.env['STAFF_JWT_SECRET'] = 'test-staff-secret-' + 'x'.repeat(20);
  process.env['PORTAL_JWT_SECRET'] = 'test-portal-secret-' + 'x'.repeat(20);
  process.env['DATABASE_URL'] = 'postgresql://vibe:vibe@localhost:5432/vibe_tb_test';
  process.env['APP_BASE_URL'] = 'http://localhost:5173';
  process.env['STAFF_COOKIE_NAME'] = '__vibe_app_session';
  resetConfigForTests();

  const redis = new RedisMock() as unknown as Redis;
  // ioredis-mock shares data across instances by default — flush so each
  // test starts from a clean state.
  await redis.flushall();
  const sessionStore = createSessionStore(redis);
  const captured: TestHarness['capturedMagicLinks'] = [];
  const capturedEmailOtps: TestHarness['capturedEmailOtps'] = [];
  const capturedSmsOtps: TestHarness['capturedSmsOtps'] = [];

  const app = createApp({
    db: overrides.db ?? null,
    redis: overrides.redis ?? redis,
    sessionStore: overrides.sessionStore ?? sessionStore,
    sendMagicLink:
      overrides.sendMagicLink ??
      (async (args) => {
        captured.push(args);
      }),
    sendEmailOtp:
      overrides.sendEmailOtp ??
      (async (args) => {
        capturedEmailOtps.push(args);
      }),
    sendSmsOtp:
      overrides.sendSmsOtp ??
      (async (args) => {
        capturedSmsOtps.push(args);
      }),
    fakeUserRoles: overrides.fakeUserRoles,
  });

  return { app, redis, capturedMagicLinks: captured, capturedEmailOtps, capturedSmsOtps };
}
