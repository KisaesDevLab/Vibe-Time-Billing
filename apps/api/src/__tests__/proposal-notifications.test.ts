// SPDX-License-Identifier: Elastic-2.0
//
// P26 + P27 — Proposal notification template tests.

import { describe, expect, it } from 'vitest';

import {
  EMAIL_TEMPLATES,
  SMS_TEMPLATES,
  renderEmail,
  renderSms,
} from '../proposals/notification-templates';
import { createEmailItProvider } from '../mail/provider';
import pino from 'pino';

const log = pino({ level: 'silent' });

function ctx() {
  return {
    client: { name: 'Acme Co' },
    firm: { name: 'Smith CPAs' },
    engagement: {
      name: 'Annual Tax 2026',
      end_date: '2026-04-15',
    },
    proposal: {
      url: 'https://portal.firm.example/p/abc',
      short_url: 'https://prt.cx/abc',
      expires_at: '2026-05-31',
    },
    portal: {
      payment_methods_url: 'https://portal.firm.example/payment-methods',
      short_url: 'https://prt.cx/pm',
    },
    today: '2026-04-15',
  };
}

describe('P26 — email templates', () => {
  it('catalog has all 10 named events', () => {
    expect(Object.keys(EMAIL_TEMPLATES).sort()).toEqual([
      'mandate_invalid',
      'payment_failed',
      'payment_received',
      'proposal_accepted_client',
      'proposal_accepted_firm',
      'proposal_declined',
      'proposal_expiring',
      'proposal_sent',
      'proposal_viewed_reminder',
      'renewal_upcoming',
    ]);
  });

  it('resolves merge tokens in subject + body', () => {
    const r = renderEmail('proposal_sent', ctx());
    expect(r.subject).toBe('Your engagement proposal from Smith CPAs');
    expect(r.body).toContain('Hi Acme Co');
    expect(r.body).toContain('https://portal.firm.example/p/abc');
    expect(r.body).toContain('2026-05-31');
    expect(r.body).toContain('— Smith CPAs');
  });

  it('every template body length is reasonable (≤2000 chars)', () => {
    for (const [k, t] of Object.entries(EMAIL_TEMPLATES)) {
      expect(t.body.length, `${k} body too long`).toBeLessThan(2000);
      expect(t.subject.length, `${k} subject too long`).toBeLessThan(120);
    }
  });

  it('throws on unknown event', () => {
    expect(() => renderEmail('not_a_real_event' as never, ctx())).toThrow(/unknown_email_event/);
  });
});

describe('P27 — SMS templates', () => {
  it('catalog has all 4 named events', () => {
    expect(Object.keys(SMS_TEMPLATES).sort()).toEqual([
      'mandate_invalid',
      'payment_failed',
      'proposal_reminder',
      'signed_receipt',
    ]);
  });

  it('resolves merge tokens', () => {
    const r = renderSms('proposal_reminder', ctx());
    expect(r.body).toContain('Smith CPAs');
    expect(r.body).toContain('https://prt.cx/abc');
    expect(r.body).toContain('2026-05-31');
  });

  it('every SMS body resolves to ≤200 chars after substitution', () => {
    // Leave 40 chars of slack for typical merged values vs the 160
    // single-segment limit. The two flavors of variable substitution
    // (short URLs, short names) keep us under in practice.
    for (const k of Object.keys(SMS_TEMPLATES)) {
      const rendered = renderSms(k as never, ctx());
      expect(rendered.body.length, `${k} too long after merge`).toBeLessThan(200);
    }
  });
});

describe('P26 — EmailIt provider', () => {
  it('POSTs JSON to api.emailit.com', async () => {
    let calledUrl = '';
    let calledBody = '';
    const fetchImpl: typeof fetch = (async (url: string, init: RequestInit) => {
      calledUrl = url;
      calledBody = String(init.body);
      return new Response(JSON.stringify({ id: 'msg-123' }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = createEmailItProvider(
      { apiKey: 'sk-test', from: 'firm@example.com', fetchImpl },
      log,
    );
    const result = await provider.send({
      to: 'client@example.com',
      subject: 'Hello',
      body: 'Plain text',
      html: '<p>HTML</p>',
    });
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('msg-123');
    expect(calledUrl).toBe('https://api.emailit.com/v1/emails');
    expect(calledBody).toContain('"from":"firm@example.com"');
    expect(calledBody).toContain('"to":["client@example.com"]');
    expect(calledBody).toContain('"subject":"Hello"');
    expect(calledBody).toContain('"html":"<p>HTML</p>"');
  });

  it('returns error on non-2xx', async () => {
    const fetchImpl: typeof fetch = (async () =>
      new Response(JSON.stringify({ message: 'over_quota' }), {
        status: 429,
      })) as unknown as typeof fetch;
    const provider = createEmailItProvider({ apiKey: 'x', from: 'f@x.com', fetchImpl }, log);
    const result = await provider.send({ to: 't@x.com', subject: 's', body: 'b' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('over_quota');
  });
});
