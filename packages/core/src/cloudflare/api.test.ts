// SPDX-License-Identifier: Elastic-2.0

import { describe, expect, it } from 'vitest';

import { createCloudflareClient, CloudflareApiError, type FetchFn } from './api';

interface FakeCall {
  method: string;
  url: string;
  body: unknown;
}

function buildFakeFetch(handler: (call: FakeCall) => { status: number; envelope: unknown }): {
  fetch: FetchFn;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetch: FetchFn = async (url, init) => {
    const call: FakeCall = {
      method: init?.method ?? 'GET',
      url,
      body: init?.body ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const { status, envelope } = handler(call);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => envelope,
      text: async () => JSON.stringify(envelope),
    };
  };
  return { fetch, calls };
}

describe('CloudflareClient', () => {
  it('validateApiToken sends Bearer auth and returns account id', async () => {
    const { fetch, calls } = buildFakeFetch(() => ({
      status: 200,
      envelope: { success: true, errors: [], result: { id: 'acc-1' } },
    }));
    const client = createCloudflareClient({ apiToken: 'tok-abc', fetchImpl: fetch });
    const r = await client.validateApiToken('acc-1');
    expect(r.accountId).toBe('acc-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain('/accounts/acc-1');
  });

  it('throws CloudflareApiError with code + message on success:false', async () => {
    const { fetch } = buildFakeFetch(() => ({
      status: 400,
      envelope: {
        success: false,
        errors: [{ code: 1006, message: 'Invalid zone identifier' }],
        result: null,
      },
    }));
    const client = createCloudflareClient({ apiToken: 'tok', fetchImpl: fetch });
    await expect(client.getZone('bad')).rejects.toThrow(/Invalid zone identifier/);
    await expect(client.getZone('bad')).rejects.toBeInstanceOf(CloudflareApiError);
  });

  it('createTunnel POSTs with config_src cloudflare', async () => {
    const { fetch, calls } = buildFakeFetch(() => ({
      status: 200,
      envelope: {
        success: true,
        errors: [],
        result: { id: 'tnl-1', name: 'vibe', created_at: 't', account_tag: 'a' },
      },
    }));
    const client = createCloudflareClient({ apiToken: 'tok', fetchImpl: fetch });
    const tnl = await client.createTunnel('acc-1', 'vibe');
    expect(tnl.id).toBe('tnl-1');
    expect(calls[0]!.method).toBe('POST');
    expect((calls[0]!.body as { name: string; config_src: string }).config_src).toBe('cloudflare');
  });

  it('upsertCnameRecord PATCHes when an existing record is found, POSTs when not', async () => {
    let phase: 'lookup-existing' | 'patch' | 'lookup-missing' | 'create' = 'lookup-existing';
    const { fetch, calls } = buildFakeFetch(() => {
      if (phase === 'lookup-existing') {
        phase = 'patch';
        return {
          status: 200,
          envelope: {
            success: true,
            errors: [],
            result: [
              { id: 'rec-1', type: 'CNAME', name: 'app.x.com', content: 'old', proxied: true },
            ],
          },
        };
      }
      if (phase === 'patch') {
        phase = 'lookup-missing';
        return {
          status: 200,
          envelope: {
            success: true,
            errors: [],
            result: {
              id: 'rec-1',
              type: 'CNAME',
              name: 'app.x.com',
              content: 'new',
              proxied: true,
            },
          },
        };
      }
      if (phase === 'lookup-missing') {
        phase = 'create';
        return { status: 200, envelope: { success: true, errors: [], result: [] } };
      }
      return {
        status: 200,
        envelope: {
          success: true,
          errors: [],
          result: {
            id: 'rec-2',
            type: 'CNAME',
            name: 'portal.x.com',
            content: 'new',
            proxied: true,
          },
        },
      };
    });
    const client = createCloudflareClient({ apiToken: 'tok', fetchImpl: fetch });
    await client.upsertCnameRecord('zone-1', 'app.x.com', 'tnl.cfargotunnel.com');
    await client.upsertCnameRecord('zone-1', 'portal.x.com', 'tnl.cfargotunnel.com');
    // 4 calls: lookup+patch, lookup+post.
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH', 'GET', 'POST']);
  });

  it('setTunnelIngress wraps the config in { config: ... }', async () => {
    const { fetch, calls } = buildFakeFetch(() => ({
      status: 200,
      envelope: { success: true, errors: [], result: {} },
    }));
    const client = createCloudflareClient({ apiToken: 'tok', fetchImpl: fetch });
    await client.setTunnelIngress('acc-1', 'tnl-1', {
      ingress: [
        { hostname: 'app.x.com', service: 'http://caddy:80' },
        { service: 'http_status:404' },
      ],
    });
    expect((calls[0]!.body as { config: { ingress: unknown[] } }).config.ingress).toHaveLength(2);
  });

  it('listAccounts returns id+name pairs from /accounts', async () => {
    const { fetch, calls } = buildFakeFetch(() => ({
      status: 200,
      envelope: {
        success: true,
        errors: [],
        result: [
          { id: 'acc-1', name: 'Granite Peak', extra: 'ignored' },
          { id: 'acc-2', name: 'Second Co' },
        ],
      },
    }));
    const client = createCloudflareClient({ apiToken: 'tok', fetchImpl: fetch });
    const accts = await client.listAccounts();
    expect(accts).toEqual([
      { id: 'acc-1', name: 'Granite Peak' },
      { id: 'acc-2', name: 'Second Co' },
    ]);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toContain('/accounts?per_page=50');
  });

  it('listZones maps account id and filters by account when given', async () => {
    const { fetch, calls } = buildFakeFetch(() => ({
      status: 200,
      envelope: {
        success: true,
        errors: [],
        result: [
          { id: 'z1', name: 'firm.com', status: 'active', account: { id: 'acc-1' } },
          { id: 'z2', name: 'other.com', status: 'pending' },
        ],
      },
    }));
    const client = createCloudflareClient({ apiToken: 'tok', fetchImpl: fetch });
    const zones = await client.listZones('acc-1');
    expect(zones).toEqual([
      { id: 'z1', name: 'firm.com', status: 'active', accountId: 'acc-1' },
      { id: 'z2', name: 'other.com', status: 'pending', accountId: null },
    ]);
    expect(calls[0]!.url).toContain('/zones?per_page=50&account.id=acc-1');
  });

  it('deleteDnsRecord and deleteTunnel use DELETE', async () => {
    const { fetch, calls } = buildFakeFetch(() => ({
      status: 200,
      envelope: { success: true, errors: [], result: {} },
    }));
    const client = createCloudflareClient({ apiToken: 'tok', fetchImpl: fetch });
    await client.deleteDnsRecord('zone-1', 'rec-1');
    await client.deleteTunnel('acc-1', 'tnl-1');
    expect(calls.map((c) => c.method)).toEqual(['DELETE', 'DELETE']);
  });
});
