// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { describe, it, expect } from 'vitest';

import {
  statusTemplateKind,
  renderStatusNotification,
  DEFAULT_STATUS_TEMPLATES,
  STATUS_NOTIFICATION_TOKENS,
  type StatusNotificationContext,
} from './status-templates';

const ctx: StatusNotificationContext = {
  client: { name: 'Vance Holdings LLC' },
  firm: { name: 'Wilson & Co CPAs' },
  engagement: { name: '2025 Form 1065' },
  status: {
    label: 'With client',
    client_label: 'Waiting on you',
    client_description: 'We need your signed e-file authorization to proceed.',
  },
  recipient: { name: 'Lisa Vance' },
  today: '2026-06-11',
};

describe('statusTemplateKind', () => {
  it('namespaces by workflow state', () => {
    expect(statusTemplateKind('WITH_CLIENT')).toBe('engagement_status:WITH_CLIENT');
    expect(statusTemplateKind('custom_state')).toBe('engagement_status:custom_state');
  });
});

describe('renderStatusNotification', () => {
  it('renders the default EMAIL template with all tokens', () => {
    const r = renderStatusNotification({ channel: 'EMAIL', template: null, context: ctx });
    expect(r.subject).toBe('Update on 2025 Form 1065');
    expect(r.body).toContain('Hi Lisa Vance,');
    expect(r.body).toContain('Wilson & Co CPAs');
    expect(r.body).toContain('"Waiting on you"');
    expect(r.body).toContain('signed e-file authorization');
  });

  it('renders the default SMS template without a subject', () => {
    const r = renderStatusNotification({ channel: 'SMS', template: null, context: ctx });
    expect(r.subject).toBeNull();
    expect(r.body).toBe(
      'Wilson & Co CPAs: 2025 Form 1065 for Vance Holdings LLC is now "Waiting on you".',
    );
  });

  it('renders PORTAL subject as a title', () => {
    const r = renderStatusNotification({ channel: 'PORTAL', template: null, context: ctx });
    expect(r.subject).toBe('2025 Form 1065 is now Waiting on you');
    expect(r.body).toBe('We need your signed e-file authorization to proceed.');
  });

  it('uses a firm template over the default', () => {
    const r = renderStatusNotification({
      channel: 'EMAIL',
      template: { subject: 'Re {{client.name}}', body: 'Now {{status.label}}.' },
      context: ctx,
    });
    expect(r.subject).toBe('Re Vance Holdings LLC');
    expect(r.body).toBe('Now With client.');
  });

  it('collapses blank lines when client_description is empty', () => {
    const empty = {
      ...ctx,
      status: { ...ctx.status, client_description: '' },
    };
    const r = renderStatusNotification({ channel: 'EMAIL', template: null, context: empty });
    expect(r.body).not.toMatch(/\n{3,}/);
    expect(r.body.endsWith('Wilson & Co CPAs')).toBe(true);
  });

  it('unknown tokens render empty, not literal braces', () => {
    const r = renderStatusNotification({
      channel: 'SMS',
      template: { body: 'X {{bogus.token}} Y' },
      context: ctx,
    });
    expect(r.body).toBe('X  Y');
    expect(r.body).not.toContain('{{');
  });
});

describe('catalogs', () => {
  it('every default template token appears in the picker catalog', () => {
    const catalog = new Set(STATUS_NOTIFICATION_TOKENS.map((t) => t.token));
    for (const tpl of Object.values(DEFAULT_STATUS_TEMPLATES)) {
      const text = `${tpl.subject ?? ''}\n${tpl.body}`;
      for (const m of text.matchAll(/\{\{\s*([a-z_.]+)\s*\}\}/g)) {
        expect(catalog.has(m[1]!)).toBe(true);
      }
    }
  });
});
