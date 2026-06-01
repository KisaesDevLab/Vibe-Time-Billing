// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// 0085 — Admin > Operations > Cloudflare Tunnel.
//
// 3-step wizard for first-time provisioning, then a live status panel.
// All endpoints sit under /api/staff/admin/cloudflare-tunnel and gate
// on firm:settings:write.

import { useEffect, useState } from 'react';

import { Button, Card, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

type Status = 'INACTIVE' | 'PROVISIONING' | 'ACTIVE' | 'ERROR';

interface MetricsSnapshot {
  ready: boolean;
  connectorCount: number;
  region: string | null;
  checkedAt: string;
}

interface CurrentConfig {
  id: string;
  accountId: string | null;
  zoneId: string | null;
  zoneName: string | null;
  staffHostname: string | null;
  portalHostname: string | null;
  tunnelId: string | null;
  tunnelName: string | null;
  apiTokenHint: string | null;
  status: Status;
  lastError: string | null;
  lastProvisionedAt: string | null;
  lastStatusCheckAt: string | null;
  metricsSnapshot: MetricsSnapshot | null;
}

interface ValidateResp {
  ok: boolean;
  zoneName: string;
  zoneStatus: string;
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

export function CloudflareTunnelPage(): JSX.Element {
  const [config, setConfig] = useState<CurrentConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Wizard fields.
  const [apiToken, setApiToken] = useState('');
  const [accountId, setAccountId] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [validated, setValidated] = useState<ValidateResp | null>(null);
  const [validating, setValidating] = useState(false);
  const [staffSub, setStaffSub] = useState('app');
  const [portalSub, setPortalSub] = useState('portal');
  const [provisioning, setProvisioning] = useState(false);

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

  // Poll status every 15s once provisioned so the UI reflects sidecar
  // health without a manual refresh.
  useEffect(() => {
    if (!config || config.status !== 'ACTIVE') return;
    const t = setInterval(() => {
      void load();
    }, 15_000);
    return () => clearInterval(t);
    // Only the status + id matter for whether polling should run;
    // listing `config` itself would re-create the interval on every
    // load() round-trip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.status, config?.id]);

  async function validate(): Promise<void> {
    setError(null);
    setValidating(true);
    try {
      const r = await api<ValidateResp>('/api/staff/admin/cloudflare-tunnel/validate', {
        method: 'POST',
        body: JSON.stringify({ apiToken, accountId, zoneId }),
      });
      setValidated(r);
    } catch (err) {
      setValidated(null);
      setError(err instanceof Error ? err.message : 'validate_failed');
    } finally {
      setValidating(false);
    }
  }

  async function provision(): Promise<void> {
    if (!validated) return;
    const staffHostname = `${staffSub}.${validated.zoneName}`;
    const portalHostname = portalSub.trim() ? `${portalSub}.${validated.zoneName}` : null;
    setError(null);
    setProvisioning(true);
    try {
      await api('/api/staff/admin/cloudflare-tunnel/provision', {
        method: 'POST',
        body: JSON.stringify({
          apiToken,
          accountId,
          zoneId,
          staffHostname,
          portalHostname,
        }),
      });
      setApiToken('');
      setValidated(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'provision_failed');
    } finally {
      setProvisioning(false);
    }
  }

  async function deprovision(): Promise<void> {
    if (
      !window.confirm(
        'Delete the tunnel and its DNS records? Traffic via app./portal. will stop until you re-provision.',
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

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 760 }}>
      <Card>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Cloudflare Tunnel</h2>
        <p style={{ fontSize: 13, color: tokens.color.textMuted, marginTop: 4 }}>
          Connect your appliance to your firm&apos;s domain via a Cloudflare Tunnel — no public IP
          or open ports required. You keep ownership of the Cloudflare account; this UI only stores
          tokens you provide.
        </p>
      </Card>

      {error && (
        <Card>
          <p style={{ color: tokens.color.danger, fontSize: 13, margin: 0 }}>{error}</p>
        </Card>
      )}

      {!inWizard && config && (
        <Card>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
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
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button variant="secondary" onClick={() => void load()}>
                Refresh
              </Button>
              <Button variant="ghost" onClick={() => void deprovision()}>
                Disable
              </Button>
            </div>
          </div>

          <div
            style={{
              marginTop: 12,
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 12,
              fontSize: 13,
            }}
          >
            <div>
              <div style={labelStyle}>Staff URL</div>
              <code>https://{config.staffHostname}</code>
            </div>
            <div>
              <div style={labelStyle}>Portal URL</div>
              {config.portalHostname ? (
                <code>https://{config.portalHostname}</code>
              ) : (
                <span style={{ color: tokens.color.textMuted }}>— not set —</span>
              )}
            </div>
            <div>
              <div style={labelStyle}>Tunnel ID</div>
              <code style={{ fontSize: 11 }}>{config.tunnelId}</code>
            </div>
            <div>
              <div style={labelStyle}>Last provisioned</div>
              <span>
                {config.lastProvisionedAt
                  ? new Date(config.lastProvisionedAt).toLocaleString()
                  : '—'}
              </span>
            </div>
            <div>
              <div style={labelStyle}>Last status check</div>
              <span>
                {config.lastStatusCheckAt
                  ? new Date(config.lastStatusCheckAt).toLocaleString()
                  : '—'}
              </span>
            </div>
            <div>
              <div style={labelStyle}>Edge region</div>
              <span>{config.metricsSnapshot?.region ?? '—'}</span>
            </div>
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

      {(inWizard || config?.status === 'ERROR') && (
        <Card>
          <h3 style={{ marginTop: 0, fontSize: 15 }}>
            {config?.status === 'ERROR' ? 'Re-provision' : 'Set up tunnel'}
          </h3>

          <div style={{ display: 'grid', gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                <strong>Step 1.</strong> Paste your Cloudflare credentials. The token needs{' '}
                <code>Account:Cloudflare Tunnel:Edit</code>
                {' + '}
                <code>Zone:DNS:Edit</code> on the zone below.
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: 8,
                }}
              >
                <div>
                  <div style={labelStyle}>Account ID</div>
                  <input
                    style={inputStyle}
                    value={accountId}
                    onChange={(e) => setAccountId(e.target.value.trim())}
                    placeholder="32-char hex"
                  />
                </div>
                <div>
                  <div style={labelStyle}>Zone ID</div>
                  <input
                    style={inputStyle}
                    value={zoneId}
                    onChange={(e) => setZoneId(e.target.value.trim())}
                    placeholder="32-char hex"
                  />
                </div>
              </div>
              <div style={{ marginTop: 8 }}>
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
              <div style={{ marginTop: 10 }}>
                <Button
                  onClick={() => void validate()}
                  disabled={validating || !apiToken || !accountId || !zoneId}
                >
                  {validating ? 'Validating…' : 'Validate credentials'}
                </Button>
                {validated && (
                  <span style={{ marginLeft: 10, fontSize: 13 }}>
                    <Pill tone="success">
                      Verified: {validated.zoneName} ({validated.zoneStatus})
                    </Pill>
                  </span>
                )}
              </div>
            </div>

            {validated && (
              <div>
                <div style={{ fontSize: 13, marginBottom: 8 }}>
                  <strong>Step 2.</strong> Pick subdomains. The wizard will create CNAMEs on{' '}
                  <code>{validated.zoneName}</code>.
                </div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 8,
                  }}
                >
                  <div>
                    <div style={labelStyle}>Staff subdomain</div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input
                        style={{ ...inputStyle, flex: 1 }}
                        value={staffSub}
                        onChange={(e) =>
                          setStaffSub(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                        }
                      />
                      <span style={{ fontSize: 13 }}>.{validated.zoneName}</span>
                    </div>
                  </div>
                  <div>
                    <div style={labelStyle}>
                      Portal subdomain{' '}
                      <span style={{ color: tokens.color.textMuted }}>
                        (always saved; ingress active when licensed)
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <input
                        style={{ ...inputStyle, flex: 1 }}
                        value={portalSub}
                        onChange={(e) =>
                          setPortalSub(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                        }
                      />
                      <span style={{ fontSize: 13 }}>.{validated.zoneName}</span>
                    </div>
                  </div>
                </div>
                <div style={{ marginTop: 12 }}>
                  <Button onClick={() => void provision()} disabled={provisioning || !staffSub}>
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
