// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Admin > Operations > Cloudflare Tunnel.
//
// Wizard: paste an API token → Connect (discovers accounts + zones) →
// pick account + domain from dropdowns → add/remove a list of hostnames
// (each tagged Staff or Portal) → Provision. Once active, a status panel
// shows live connector health and lets the operator edit the hostname
// list in place (no tunnel teardown) or disable the tunnel.
//
// All endpoints sit under /api/staff/admin/cloudflare-tunnel and gate on
// firm:settings:write.

import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

type Status = 'INACTIVE' | 'PROVISIONING' | 'ACTIVE' | 'ERROR';
type Realm = 'STAFF' | 'PORTAL' | 'ESIGN';

interface MetricsSnapshot {
  ready: boolean;
  connectorCount: number;
  region: string | null;
  checkedAt: string;
}

interface HostnameEntry {
  hostname: string;
  realm: Realm;
}

interface CurrentConfig {
  id: string;
  accountId: string | null;
  zoneId: string | null;
  zoneName: string | null;
  staffHostname: string | null;
  portalHostname: string | null;
  hostnames: HostnameEntry[];
  tunnelId: string | null;
  tunnelName: string | null;
  apiTokenHint: string | null;
  status: Status;
  lastError: string | null;
  lastProvisionedAt: string | null;
  lastStatusCheckAt: string | null;
  metricsSnapshot: MetricsSnapshot | null;
}

interface Account {
  id: string;
  name: string;
}
interface ZoneItem {
  id: string;
  name: string;
  status: string;
  accountId: string | null;
}
interface DiscoverResp {
  ok: boolean;
  accounts: Account[];
  zones: ZoneItem[];
}

// A subdomain label + realm row used by both the provision wizard and the
// in-place edit form.
interface HostRow {
  sub: string;
  realm: Realm;
}

const labelStyle: React.CSSProperties = {
  fontSize: 12,
  color: tokens.color.textMuted,
  marginBottom: 4,
  display: 'block',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: tokens.space.sm,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.sm,
  fontSize: 13,
};

function statusTone(s: Status): 'success' | 'warning' | 'neutral' | 'danger' {
  switch (s) {
    case 'ACTIVE':
      return 'success';
    case 'PROVISIONING':
      return 'warning';
    case 'ERROR':
      return 'danger';
    default:
      return 'neutral';
  }
}

const sanitizeSub = (v: string): string => v.toLowerCase().replace(/[^a-z0-9-]/g, '');

function subToHostname(sub: string, zone: string): string {
  const s = sanitizeSub(sub);
  return s ? `${s}.${zone}` : zone;
}

function hostnameToSub(hostname: string, zone: string): string {
  return hostname.endsWith(`.${zone}`) ? hostname.slice(0, -(zone.length + 1)) : hostname;
}

// Shared editor for a list of hostname rows.
function HostnameRows({
  rows,
  setRows,
  zoneName,
}: {
  rows: HostRow[];
  setRows: (r: HostRow[]) => void;
  zoneName: string;
}): JSX.Element {
  const update = (i: number, patch: Partial<HostRow>): void => {
    setRows(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            style={{ ...inputStyle, flex: 1 }}
            value={r.sub}
            placeholder="subdomain"
            onChange={(e) => update(i, { sub: sanitizeSub(e.target.value) })}
          />
          <span style={{ fontSize: 13, color: tokens.color.textMuted, whiteSpace: 'nowrap' }}>
            .{zoneName || 'your-domain'}
          </span>
          <select
            style={{ ...inputStyle, width: 110 }}
            value={r.realm}
            onChange={(e) => update(i, { realm: e.target.value as Realm })}
          >
            <option value="STAFF">Staff</option>
            <option value="PORTAL">Portal</option>
            <option value="ESIGN">E-sign</option>
          </select>
          <Button
            variant="ghost"
            onClick={() => setRows(rows.filter((_, idx) => idx !== i))}
            disabled={rows.length <= 1}
          >
            ✕
          </Button>
        </div>
      ))}
      <div>
        <Button variant="secondary" onClick={() => setRows([...rows, { sub: '', realm: 'STAFF' }])}>
          + Add hostname
        </Button>
      </div>
    </div>
  );
}

export function CloudflareTunnelPage(): JSX.Element {
  const [config, setConfig] = useState<CurrentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Wizard state.
  const [apiToken, setApiToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [discovered, setDiscovered] = useState<DiscoverResp | null>(null);
  const [accountId, setAccountId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [rows, setRows] = useState<HostRow[]>([
    { sub: 'app', realm: 'STAFF' },
    { sub: 'portal', realm: 'PORTAL' },
  ]);
  const [provisioning, setProvisioning] = useState(false);

  // Edit-in-place state.
  const [editing, setEditing] = useState(false);
  const [editRows, setEditRows] = useState<HostRow[]>([]);
  const [savingEdit, setSavingEdit] = useState(false);

  const zoneName = discovered?.zones.find((z) => z.id === zoneId)?.name ?? '';

  async function load(): Promise<void> {
    setLoading(true);
    try {
      const r = await api<{ config: CurrentConfig | null }>('/api/staff/admin/cloudflare-tunnel');
      setConfig(r.config);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!config || config.status !== 'ACTIVE') return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.status, config?.id]);

  async function connect(): Promise<void> {
    setError(null);
    setConnecting(true);
    try {
      const r = await api<DiscoverResp>('/api/staff/admin/cloudflare-tunnel/discover', {
        method: 'POST',
        body: JSON.stringify({ apiToken }),
      });
      setDiscovered(r);
      const firstAccount = r.accounts[0]?.id ?? '';
      setAccountId(firstAccount);
      const firstZone =
        r.zones.find((z) => !z.accountId || z.accountId === firstAccount)?.id ??
        r.zones[0]?.id ??
        '';
      setZoneId(firstZone);
    } catch (err) {
      setDiscovered(null);
      setError(err instanceof Error ? err.message : 'connect_failed');
    } finally {
      setConnecting(false);
    }
  }

  async function provision(): Promise<void> {
    if (!zoneName) return;
    const hostnames = rows
      .filter((r) => r.sub.trim())
      .map((r) => ({ hostname: subToHostname(r.sub, zoneName), realm: r.realm }));
    if (hostnames.length === 0) {
      setError('Add at least one hostname.');
      return;
    }
    setError(null);
    setProvisioning(true);
    try {
      await api('/api/staff/admin/cloudflare-tunnel/provision', {
        method: 'POST',
        body: JSON.stringify({ apiToken, accountId, zoneId, hostnames }),
      });
      setApiToken('');
      setDiscovered(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'provision_failed');
    } finally {
      setProvisioning(false);
    }
  }

  function startEdit(): void {
    if (!config?.zoneName) return;
    setEditRows(
      config.hostnames.map((h) => ({
        sub: hostnameToSub(h.hostname, config.zoneName!),
        realm: h.realm,
      })),
    );
    setEditing(true);
  }

  async function saveEdit(): Promise<void> {
    if (!config?.zoneName) return;
    const hostnames = editRows
      .filter((r) => r.sub.trim())
      .map((r) => ({ hostname: subToHostname(r.sub, config.zoneName!), realm: r.realm }));
    if (hostnames.length === 0) {
      setError('Keep at least one hostname.');
      return;
    }
    setError(null);
    setSavingEdit(true);
    try {
      await api('/api/staff/admin/cloudflare-tunnel/update', {
        method: 'POST',
        body: JSON.stringify({ hostnames }),
      });
      setEditing(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'update_failed');
    } finally {
      setSavingEdit(false);
    }
  }

  async function deprovision(): Promise<void> {
    if (
      !window.confirm(
        'Delete the tunnel and all its DNS records? Traffic will stop until you re-provision.',
      )
    ) {
      return;
    }
    setError(null);
    try {
      await api('/api/staff/admin/cloudflare-tunnel/deprovision', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'deprovision_failed');
    }
  }

  if (loading) {
    return (
      <Card>
        <p>Loading…</p>
      </Card>
    );
  }

  const inWizard = !config || config.status === 'INACTIVE';
  const zonesForAccount = discovered
    ? discovered.zones.filter((z) => !z.accountId || z.accountId === accountId)
    : [];

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760 }}>
      <Card>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Cloudflare Tunnel</h2>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 4 }}>
          Connect your appliance to your firm&apos;s domain via a Cloudflare Tunnel — no public IP
          or open ports. You keep ownership of the Cloudflare account; this UI only stores the token
          you provide (encrypted with the firm key).
        </p>
      </Card>

      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      {/* ---------- Status panel ---------- */}
      {!inWizard && config && (
        <Card>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <strong style={{ fontSize: 14 }}>Tunnel {config.tunnelName}</strong>
                <Pill tone={statusTone(config.status)}>{config.status}</Pill>
                {config.metricsSnapshot?.ready && (
                  <Pill tone="success">{config.metricsSnapshot.connectorCount} connector(s)</Pill>
                )}
                {config.metricsSnapshot && !config.metricsSnapshot.ready && (
                  <Pill tone="warning">sidecar offline</Pill>
                )}
              </div>
              <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 4 }}>
                Zone <code>{config.zoneName}</code>
                {config.apiTokenHint && <> · token ends in ...{config.apiTokenHint}</>}
                {config.metricsSnapshot?.region && <> · edge {config.metricsSnapshot.region}</>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button variant="secondary" onClick={() => void load()}>
                Refresh
              </Button>
              {!editing && <Button onClick={() => startEdit()}>Edit hostnames</Button>}
              <Button variant="ghost" onClick={() => void deprovision()}>
                Disable
              </Button>
            </div>
          </div>

          {/* Hostname list (read) or editor. */}
          <div style={{ marginTop: 14 }}>
            <div style={labelStyle}>Hostnames</div>
            {!editing ? (
              <div style={{ display: 'grid', gap: 6 }}>
                {config.hostnames.length === 0 && (
                  <span style={{ color: tokens.color.textMuted, fontSize: 13 }}>— none —</span>
                )}
                {config.hostnames.map((h) => (
                  <div key={h.hostname} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Pill
                      tone={
                        h.realm === 'PORTAL'
                          ? 'neutral'
                          : h.realm === 'ESIGN'
                            ? 'warning'
                            : 'success'
                      }
                    >
                      {h.realm === 'PORTAL' ? 'Portal' : h.realm === 'ESIGN' ? 'E-sign' : 'Staff'}
                    </Pill>
                    <code style={{ fontSize: 13 }}>https://{h.hostname}</code>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                <HostnameRows
                  rows={editRows}
                  setRows={setEditRows}
                  zoneName={config.zoneName ?? ''}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button onClick={() => void saveEdit()} disabled={savingEdit}>
                    {savingEdit ? 'Saving…' : 'Save changes'}
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(false)} disabled={savingEdit}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>

          {config.lastError && (
            <div
              style={{
                marginTop: 12,
                padding: 10,
                border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.md,
                fontSize: 12,
                color: tokens.color.danger,
                background: tokens.color.surface,
              }}
            >
              <strong>Last error:</strong> {config.lastError}
            </div>
          )}
        </Card>
      )}

      {/* ---------- Provision wizard ---------- */}
      {(inWizard || config?.status === 'ERROR') && (
        <Card>
          <h3 style={{ marginTop: 0, fontSize: 15 }}>
            {config?.status === 'ERROR' ? 'Re-provision' : 'Set up tunnel'}
          </h3>

          <div style={{ display: 'grid', gap: 14 }}>
            {/* Step 1 — token + connect */}
            <div>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                <strong>Step 1.</strong> Paste a Cloudflare API token with{' '}
                <code>Account:Cloudflare Tunnel:Edit</code> + <code>Zone:DNS:Edit</code>, then
                connect to load your accounts and domains.
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <div style={labelStyle}>API token</div>
                  <input
                    type="password"
                    style={inputStyle}
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder="Paste Cloudflare API token"
                    autoComplete="off"
                  />
                </div>
                <Button
                  onClick={() => void connect()}
                  disabled={connecting || apiToken.length < 20}
                >
                  {connecting ? 'Connecting…' : 'Connect'}
                </Button>
              </div>
            </div>

            {/* Step 2 — account + domain dropdowns */}
            {discovered && (
              <div>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  <strong>Step 2.</strong> Choose the account and domain.
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <div>
                    <div style={labelStyle}>Account</div>
                    <select
                      style={inputStyle}
                      value={accountId}
                      onChange={(e) => {
                        setAccountId(e.target.value);
                        const z = discovered.zones.find(
                          (zz) => !zz.accountId || zz.accountId === e.target.value,
                        );
                        setZoneId(z?.id ?? '');
                      }}
                    >
                      {discovered.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <div style={labelStyle}>Domain</div>
                    <select
                      style={inputStyle}
                      value={zoneId}
                      onChange={(e) => setZoneId(e.target.value)}
                    >
                      {zonesForAccount.length === 0 && <option value="">No zones found</option>}
                      {zonesForAccount.map((z) => (
                        <option key={z.id} value={z.id}>
                          {z.name} {z.status !== 'active' ? `(${z.status})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* Step 3 — hostnames */}
            {discovered && zoneName && (
              <div>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  <strong>Step 3.</strong> Add the hostnames to publish. Staff hostnames route to
                  the staff app; Portal hostnames to the client portal (active when licensed).
                </div>
                <HostnameRows rows={rows} setRows={setRows} zoneName={zoneName} />
                <div style={{ marginTop: 12 }}>
                  <Button onClick={() => void provision()} disabled={provisioning || !zoneId}>
                    {provisioning ? 'Provisioning…' : 'Provision tunnel'}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      <Card>
        <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
          The cloudflared sidecar runs inside your appliance and dials out to Cloudflare&apos;s edge
          — no inbound firewall rules required. Tokens are stored encrypted with the firm key.
        </p>
      </Card>
    </div>
  );
}
