// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P30 — Hardening: security response headers.
//
// Two middlewares — one strict-portal flavor (CSP locked to self +
// Stripe + Cloudflare), one staff-app flavor (slightly looser to
// accommodate the admin's richer surface). Both ship the standard
// set: HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-
// Policy, Permissions-Policy.
//
// Helmet would be the obvious dep but it's MIT and we'd rather not
// pull in another transitive tree for ~30 lines of header writes.

import type { NextFunction, Request, Response } from 'express';

interface HeadersOpts {
  // Override the report-only flag (default false in production).
  // Useful for ratcheting CSP up without breaking pages mid-debug.
  reportOnly?: boolean;
  // Extra script-src hosts on top of 'self' + Stripe. The proposal
  // portal needs js.stripe.com; staff needs the same. Caller can add
  // analytics here if the firm opts in.
  extraScriptSrc?: string[];
}

const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'geolocation=(), microphone=(), camera=(), payment=(self "https://js.stripe.com")',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
};

export function portalSecurityHeaders(opts: HeadersOpts = {}) {
  const scriptSrc = ["'self'", 'https://js.stripe.com', ...(opts.extraScriptSrc ?? [])].join(' ');
  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob: https:`,
    `font-src 'self' data:`,
    `connect-src 'self' https://api.stripe.com`,
    `frame-src https://js.stripe.com https://hooks.stripe.com`,
    `form-action 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ].join('; ');
  const headerName = opts.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader(headerName, csp);
    for (const [k, v] of Object.entries(COMMON_HEADERS)) {
      res.setHeader(k, v);
    }
    next();
  };
}

export function staffSecurityHeaders(opts: HeadersOpts = {}) {
  // Same outer headers, slightly looser CSP — the staff app needs
  // inline styles from the design-token system and connects to the
  // same /api/staff origin.
  const scriptSrc = ["'self'", ...(opts.extraScriptSrc ?? [])].join(' ');
  const csp = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self'`,
    `form-action 'self'`,
    `base-uri 'self'`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
  ].join('; ');
  const headerName = opts.reportOnly
    ? 'Content-Security-Policy-Report-Only'
    : 'Content-Security-Policy';
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader(headerName, csp);
    for (const [k, v] of Object.entries(COMMON_HEADERS)) {
      res.setHeader(k, v);
    }
    next();
  };
}
