// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Minimal Cloudflare REST client for in-app tunnel provisioning. We
// only call the endpoints the admin wizard actually needs:
//
//   - validateApiToken   GET  /accounts/{account_id}     (auth check)
//   - getZone            GET  /zones/{zone_id}           (resolve zone name + verify perms)
//   - createTunnel       POST /accounts/{account_id}/cfd_tunnel
//   - getTunnelToken     GET  /accounts/{account_id}/cfd_tunnel/{id}/token
//   - setTunnelIngress   PUT  /accounts/{account_id}/cfd_tunnel/{id}/configurations
//   - upsertDnsRecord    POST or PATCH /zones/{zone_id}/dns_records
//   - deleteDnsRecord    DELETE /zones/{zone_id}/dns_records/{record_id}
//   - deleteTunnel       DELETE /accounts/{account_id}/cfd_tunnel/{id}
//
// The fetch implementation is injectable so tests can pass a mock. Real
// calls use globalThis.fetch (Node 18+). All errors are surfaced as
// CloudflareApiError with the response status + cloudflare error array.

const API_BASE = 'https://api.cloudflare.com/client/v4';

export type FetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export interface CloudflareClientOptions {
  apiToken: string;
  fetchImpl?: FetchFn;
}

export class CloudflareApiError extends Error {
  status: number;
  errors: Array<{ code: number; message: string }>;
  constructor(status: number, errors: Array<{ code: number; message: string }>) {
    const summary =
      errors[0] != null ? `${errors[0].message} (code ${errors[0].code})` : `HTTP ${status}`;
    super(`Cloudflare API error: ${summary}`);
    this.status = status;
    this.errors = errors;
  }
}

export interface Zone {
  id: string;
  name: string;
  status: string;
}

export interface Account {
  id: string;
  name: string;
}

export interface ZoneListItem {
  id: string;
  name: string;
  status: string;
  accountId: string | null;
}

export interface Tunnel {
  id: string;
  name: string;
  created_at: string;
  account_tag: string;
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

export interface IngressRule {
  hostname?: string;
  service: string;
  originRequest?: {
    httpHostHeader?: string;
    noTLSVerify?: boolean;
    // Cloudflare's API expects an integer number of seconds here, NOT a
    // duration string like "30s" (which fails with code 1056).
    connectTimeout?: number;
  };
}

export interface TunnelConfiguration {
  ingress: IngressRule[];
}

interface CfEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

export function createCloudflareClient(opts: CloudflareClientOptions): {
  validateApiToken: (accountId: string) => Promise<{ accountId: string }>;
  listAccounts: () => Promise<Account[]>;
  listZones: (accountId?: string) => Promise<ZoneListItem[]>;
  getZone: (zoneId: string) => Promise<Zone>;
  createTunnel: (accountId: string, name: string) => Promise<Tunnel>;
  findTunnelByName: (accountId: string, name: string) => Promise<Tunnel | null>;
  getTunnelToken: (accountId: string, tunnelId: string) => Promise<string>;
  setTunnelIngress: (
    accountId: string,
    tunnelId: string,
    config: TunnelConfiguration,
  ) => Promise<void>;
  upsertCnameRecord: (zoneId: string, hostname: string, target: string) => Promise<DnsRecord>;
  deleteDnsRecord: (zoneId: string, recordId: string) => Promise<void>;
  findDnsRecord: (zoneId: string, hostname: string) => Promise<DnsRecord | null>;
  deleteTunnel: (accountId: string, tunnelId: string) => Promise<void>;
} {
  const fetchImpl: FetchFn = opts.fetchImpl ?? (globalThis as unknown as { fetch: FetchFn }).fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchImpl(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${opts.apiToken}`,
        'Content-Type': 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
    });
    let payload: CfEnvelope<T>;
    try {
      payload = (await res.json()) as CfEnvelope<T>;
    } catch {
      throw new CloudflareApiError(res.status, [
        { code: 0, message: `non-JSON response (HTTP ${res.status})` },
      ]);
    }
    if (!payload.success) {
      throw new CloudflareApiError(res.status, payload.errors ?? []);
    }
    return payload.result;
  }

  return {
    async validateApiToken(accountId: string): Promise<{ accountId: string }> {
      const r = await call<{ id: string }>('GET', `/accounts/${accountId}`);
      return { accountId: r.id };
    },

    // Discovery: list the accounts + zones the token can see, so the
    // admin UI can offer dropdowns instead of asking for raw 32-char
    // IDs. per_page=50 covers any realistic single firm; pagination
    // beyond that is intentionally out of scope.
    async listAccounts(): Promise<Account[]> {
      const r = await call<Array<{ id: string; name: string }>>('GET', `/accounts?per_page=50`);
      return r.map((a) => ({ id: a.id, name: a.name }));
    },

    async listZones(accountId?: string): Promise<ZoneListItem[]> {
      const qs = accountId
        ? `?per_page=50&account.id=${encodeURIComponent(accountId)}`
        : `?per_page=50`;
      const r = await call<
        Array<{ id: string; name: string; status: string; account?: { id?: string } }>
      >('GET', `/zones${qs}`);
      return r.map((z) => ({
        id: z.id,
        name: z.name,
        status: z.status,
        accountId: z.account?.id ?? null,
      }));
    },

    async getZone(zoneId: string): Promise<Zone> {
      return call<Zone>('GET', `/zones/${zoneId}`);
    },

    async createTunnel(accountId: string, name: string): Promise<Tunnel> {
      return call<Tunnel>('POST', `/accounts/${accountId}/cfd_tunnel`, {
        name,
        config_src: 'cloudflare',
      });
    },

    // Look up a live (non-deleted) tunnel by exact name — used to clean up
    // an orphan left by a failed earlier provision so re-provision doesn't
    // hit "tunnel with this name already exists" (code 1013).
    async findTunnelByName(accountId: string, name: string): Promise<Tunnel | null> {
      const list = await call<Tunnel[]>(
        'GET',
        `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`,
      );
      return list.find((t) => t.name === name) ?? null;
    },

    async getTunnelToken(accountId: string, tunnelId: string): Promise<string> {
      // Response shape is { result: "<token>" } at the envelope level —
      // call<string> returns the raw string.
      return call<string>('GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
    },

    async setTunnelIngress(
      accountId: string,
      tunnelId: string,
      config: TunnelConfiguration,
    ): Promise<void> {
      await call<unknown>('PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, {
        config,
      });
    },

    async findDnsRecord(zoneId: string, hostname: string): Promise<DnsRecord | null> {
      const list = await call<DnsRecord[]>(
        'GET',
        `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`,
      );
      return list[0] ?? null;
    },

    async upsertCnameRecord(zoneId: string, hostname: string, target: string): Promise<DnsRecord> {
      const existing = await this.findDnsRecord(zoneId, hostname);
      const body = {
        type: 'CNAME',
        name: hostname,
        content: target,
        proxied: true,
        ttl: 1,
      };
      if (existing) {
        return call<DnsRecord>('PATCH', `/zones/${zoneId}/dns_records/${existing.id}`, body);
      }
      return call<DnsRecord>('POST', `/zones/${zoneId}/dns_records`, body);
    },

    async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
      await call<unknown>('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
    },

    async deleteTunnel(accountId: string, tunnelId: string): Promise<void> {
      await call<unknown>('DELETE', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
    },
  };
}
