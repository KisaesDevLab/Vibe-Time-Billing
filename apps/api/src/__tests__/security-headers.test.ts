// SPDX-License-Identifier: Elastic-2.0
//
// P30 — security-headers middleware tests.

import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { portalSecurityHeaders, staffSecurityHeaders } from '../security/headers';

describe('P30 — portalSecurityHeaders', () => {
  it('emits CSP + HSTS + common security headers', async () => {
    const app = express();
    app.use(portalSecurityHeaders());
    app.get('/x', (_req, res) => res.send('ok'));
    const r = await request(app).get('/x');
    const csp = r.headers['content-security-policy'];
    expect(csp).toContain(`default-src 'self'`);
    expect(csp).toContain('https://js.stripe.com');
    expect(csp).toContain(`frame-ancestors 'none'`);
    expect(r.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('honors report-only mode', async () => {
    const app = express();
    app.use(portalSecurityHeaders({ reportOnly: true }));
    app.get('/x', (_req, res) => res.send('ok'));
    const r = await request(app).get('/x');
    expect(r.headers['content-security-policy']).toBeUndefined();
    expect(r.headers['content-security-policy-report-only']).toBeTruthy();
  });

  it('extra script sources are appended', async () => {
    const app = express();
    app.use(portalSecurityHeaders({ extraScriptSrc: ['https://analytics.example.com'] }));
    app.get('/x', (_req, res) => res.send('ok'));
    const r = await request(app).get('/x');
    expect(r.headers['content-security-policy']).toContain('https://analytics.example.com');
  });
});

describe('P30 — staffSecurityHeaders', () => {
  it('omits Stripe hosts; tighter connect-src', async () => {
    const app = express();
    app.use(staffSecurityHeaders());
    app.get('/x', (_req, res) => res.send('ok'));
    const r = await request(app).get('/x');
    const csp = r.headers['content-security-policy'];
    expect(csp).not.toContain('js.stripe.com');
    expect(csp).toContain(`connect-src 'self'`);
  });
});
