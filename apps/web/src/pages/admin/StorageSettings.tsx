// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Admin → Storage settings. UI for the provider + credentials that the
// boot path folds into process.env. Saving does not hot-swap the
// active StorageClient — the page surfaces a restart-required banner
// after a successful save.
//
// Backed by:
//   GET  /api/staff/admin/storage/settings
//   PUT  /api/staff/admin/storage/settings
//   POST /api/staff/admin/storage/settings/test

import { useEffect, useState } from 'react';

import { Button, Card, Input, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

type Provider = 'mock' | 'b2' | 'minio';

interface SettingsResponse {
  settings: {
    provider: Provider;
    b2: {
      endpoint: string | null;
      region: string | null;
      bucket: string | null;
      keyIdHint: string | null;
      applicationKeySet: boolean;
    };
    minio: {
      endpoint: string | null;
      region: string | null;
      bucket: string | null;
      accessKeyHint: string | null;
      secretKeySet: boolean;
    };
    lastTestedAt: string | null;
    lastTestedProvider: string | null;
    lastTestError: string | null;
    updatedAt: string;
  } | null;
  envFallback?: {
    provider: string;
    b2EndpointSet: boolean;
    b2BucketSet: boolean;
    minioEndpointSet: boolean;
    minioBucketSet: boolean;
  };
}

export function StorageSettingsPage(): JSX.Element {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [provider, setProvider] = useState<Provider>('mock');

  // B2 fields
  const [b2Endpoint, setB2Endpoint] = useState('');
  const [b2Region, setB2Region] = useState('');
  const [b2Bucket, setB2Bucket] = useState('');
  const [b2KeyId, setB2KeyId] = useState('');
  const [b2ApplicationKey, setB2ApplicationKey] = useState('');
  const [b2KeySet, setB2KeySet] = useState(false);

  // MinIO fields
  const [mEndpoint, setMEndpoint] = useState('');
  const [mRegion, setMRegion] = useState('');
  const [mBucket, setMBucket] = useState('');
  const [mAccessKey, setMAccessKey] = useState('');
  const [mSecretKey, setMSecretKey] = useState('');
  const [mSecretSet, setMSecretSet] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    latencyMs?: number;
    error?: string;
  } | null>(null);
  const [restartBanner, setRestartBanner] = useState(false);

  async function load(): Promise<void> {
    setError(null);
    try {
      const r = await api<SettingsResponse>('/api/staff/admin/storage/settings');
      setData(r);
      if (r.settings) {
        setProvider(r.settings.provider);
        setB2Endpoint(r.settings.b2.endpoint ?? '');
        setB2Region(r.settings.b2.region ?? '');
        setB2Bucket(r.settings.b2.bucket ?? '');
        setB2KeyId(r.settings.b2.keyIdHint ? `(saved · ${r.settings.b2.keyIdHint})` : '');
        setB2KeySet(r.settings.b2.applicationKeySet);
        setMEndpoint(r.settings.minio.endpoint ?? '');
        setMRegion(r.settings.minio.region ?? '');
        setMBucket(r.settings.minio.bucket ?? '');
        setMAccessKey(
          r.settings.minio.accessKeyHint ? `(saved · ${r.settings.minio.accessKeyHint})` : '',
        );
        setMSecretSet(r.settings.minio.secretKeySet);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  function buildPutPayload(): Record<string, unknown> {
    const body: Record<string, unknown> = { provider };
    if (provider === 'b2') {
      // Only send the keyId if it's been edited (i.e. not the masked
      // hint we showed). Mask format: starts with "(saved · ".
      const keyIdEdited = b2KeyId && !b2KeyId.startsWith('(saved');
      body['b2'] = {
        endpoint: b2Endpoint,
        region: b2Region,
        bucket: b2Bucket,
        // If unchanged, fall back to a sentinel — backend reads the
        // hint to detect that. Simpler approach: always require keyId
        // re-entry on B2 saves. Compact UX: keep the saved hint and
        // only POST when user typed new value.
        keyId: keyIdEdited ? b2KeyId : '',
      };
      if (b2ApplicationKey)
        (body['b2'] as Record<string, unknown>)['applicationKey'] = b2ApplicationKey;
    } else if (provider === 'minio') {
      const accessKeyEdited = mAccessKey && !mAccessKey.startsWith('(saved');
      body['minio'] = {
        endpoint: mEndpoint,
        region: mRegion,
        bucket: mBucket,
        accessKey: accessKeyEdited ? mAccessKey : '',
      };
      if (mSecretKey) (body['minio'] as Record<string, unknown>)['secretKey'] = mSecretKey;
    }
    return body;
  }

  async function save(): Promise<void> {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const body = buildPutPayload();
      // Server rejects empty keyId/accessKey strings as invalid. If the
      // user didn't re-type, we can't save — surface a clear hint.
      if (provider === 'b2') {
        const b = body['b2'] as { keyId: string } | undefined;
        if (!b || !b.keyId) {
          setError('Re-type the B2 Key ID to save (we mask the stored value for security).');
          setBusy(false);
          return;
        }
      }
      if (provider === 'minio') {
        const m = body['minio'] as { accessKey: string } | undefined;
        if (!m || !m.accessKey) {
          setError('Re-type the MinIO access key to save (we mask the stored value).');
          setBusy(false);
          return;
        }
      }
      const r = await api<{ ok: boolean; restartRequired?: boolean }>(
        '/api/staff/admin/storage/settings',
        { method: 'PUT', body: JSON.stringify(body) },
      );
      if (r.restartRequired) setRestartBanner(true);
      setNotice('Settings saved.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'save_failed');
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    setTestResult(null);
    setError(null);
    setBusy(true);
    try {
      const body: Record<string, unknown> = { provider };
      if (provider === 'b2') {
        const keyIdEdited = b2KeyId && !b2KeyId.startsWith('(saved');
        body['b2'] = {
          endpoint: b2Endpoint,
          region: b2Region,
          bucket: b2Bucket,
          keyId: keyIdEdited ? b2KeyId : '',
          applicationKey: b2ApplicationKey || undefined,
        };
      } else if (provider === 'minio') {
        const akEdited = mAccessKey && !mAccessKey.startsWith('(saved');
        body['minio'] = {
          endpoint: mEndpoint,
          region: mRegion,
          bucket: mBucket,
          accessKey: akEdited ? mAccessKey : '',
          secretKey: mSecretKey || undefined,
        };
      }
      const r = await api<{ ok: boolean; latencyMs?: number; error?: string }>(
        '/api/staff/admin/storage/settings/test',
        { method: 'POST', body: JSON.stringify(body) },
      );
      setTestResult(r);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'test_failed';
      setTestResult({ ok: false, error: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      <Card title="File storage backend">
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 0 }}>
          Pick where uploaded client files live. Credentials are sealed with the firm key before
          they hit the database — a DB dump never leaks them. Use <strong>Test connection</strong>{' '}
          to verify before saving.
        </p>

        {restartBanner && (
          <div
            style={{
              padding: 10,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
              border: `1px solid ${tokens.color.warning}`,
              color: tokens.color.text,
              fontSize: 13,
              marginBottom: 12,
            }}
            role="alert"
          >
            ⚠ Settings saved. <strong>Restart the appliance</strong> for the new storage provider to
            take effect. Existing uploads in the previous provider stay where they are; they
            don&apos;t auto-migrate.
          </div>
        )}

        {data?.envFallback && !data.settings && (
          <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
            Currently using env-var configuration: <Pill>{data.envFallback.provider}</Pill>
            {data.envFallback.b2BucketSet && ' · B2 bucket set'}
            {data.envFallback.minioBucketSet && ' · MinIO bucket set'}
          </p>
        )}

        <fieldset
          style={{
            border: `1px solid ${tokens.color.border}`,
            borderRadius: tokens.radius.sm,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <legend
            style={{
              padding: '0 6px',
              fontSize: 11,
              color: tokens.color.textMuted,
              textTransform: 'uppercase',
              letterSpacing: 0.4,
            }}
          >
            Provider
          </legend>
          {(
            [
              ['mock', 'Mock (local filesystem, dev only)'],
              ['b2', 'Backblaze B2 (S3-compatible)'],
              ['minio', 'MinIO (self-hosted S3)'],
            ] as Array<[Provider, string]>
          ).map(([p, label]) => (
            <label
              key={p}
              style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, marginTop: 4 }}
            >
              <input type="radio" checked={provider === p} onChange={() => setProvider(p)} />
              {label}
            </label>
          ))}
        </fieldset>

        {provider === 'b2' && (
          <div
            style={{
              display: 'grid',
              gap: 10,
              padding: 12,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
            }}
          >
            <Input
              label="Endpoint"
              value={b2Endpoint}
              onChange={(e) => setB2Endpoint(e.target.value)}
              placeholder="https://s3.us-west-002.backblazeb2.com"
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Input
                label="Region"
                value={b2Region}
                onChange={(e) => setB2Region(e.target.value)}
                placeholder="us-west-002"
              />
              <Input
                label="Bucket"
                value={b2Bucket}
                onChange={(e) => setB2Bucket(e.target.value)}
                placeholder="firmname-vibe-files"
              />
            </div>
            <Input
              label="Key ID"
              value={b2KeyId}
              onChange={(e) => setB2KeyId(e.target.value)}
              placeholder="0023a1b2c3d4e5f"
            />
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                Application Key{' '}
                {b2KeySet && (
                  <span style={{ color: tokens.color.success }}>(saved — leave blank to keep)</span>
                )}
              </label>
              <input
                type="password"
                value={b2ApplicationKey}
                onChange={(e) => setB2ApplicationKey(e.target.value)}
                placeholder={b2KeySet ? '••••••••' : 'paste application key'}
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.bg,
                  color: tokens.color.text,
                }}
              />
            </div>
          </div>
        )}

        {provider === 'minio' && (
          <div
            style={{
              display: 'grid',
              gap: 10,
              padding: 12,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.sm,
              background: tokens.color.surface,
            }}
          >
            <Input
              label="Endpoint"
              value={mEndpoint}
              onChange={(e) => setMEndpoint(e.target.value)}
              placeholder="http://minio:9000"
            />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Input
                label="Region"
                value={mRegion}
                onChange={(e) => setMRegion(e.target.value)}
                placeholder="us-east-1"
              />
              <Input
                label="Bucket"
                value={mBucket}
                onChange={(e) => setMBucket(e.target.value)}
                placeholder="vibetb"
              />
            </div>
            <Input
              label="Access key"
              value={mAccessKey}
              onChange={(e) => setMAccessKey(e.target.value)}
            />
            <div style={{ display: 'grid', gap: 4 }}>
              <label style={{ fontSize: 11, color: tokens.color.textMuted }}>
                Secret key{' '}
                {mSecretSet && (
                  <span style={{ color: tokens.color.success }}>(saved — leave blank to keep)</span>
                )}
              </label>
              <input
                type="password"
                value={mSecretKey}
                onChange={(e) => setMSecretKey(e.target.value)}
                placeholder={mSecretSet ? '••••••••' : 'paste secret key'}
                style={{
                  padding: '8px 10px',
                  fontSize: 13,
                  border: `1px solid ${tokens.color.border}`,
                  borderRadius: tokens.radius.sm,
                  background: tokens.color.bg,
                  color: tokens.color.text,
                }}
              />
            </div>
          </div>
        )}

        {provider === 'mock' && (
          <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
            Files land on the appliance&apos;s local filesystem under{' '}
            <code>/data/storage-mock</code>. Fine for dev / single-host installs; switch to B2 or
            MinIO for production durability.
          </p>
        )}

        {error && (
          <p style={{ color: tokens.color.danger, fontSize: 12, marginTop: 12 }} role="alert">
            {error}
          </p>
        )}
        {notice && !error && (
          <p style={{ color: tokens.color.success, fontSize: 12, marginTop: 12 }}>{notice}</p>
        )}
        {testResult && (
          <p
            style={{
              color: testResult.ok ? tokens.color.success : tokens.color.danger,
              fontSize: 12,
              marginTop: 12,
            }}
          >
            {testResult.ok
              ? `Connection OK · ${testResult.latencyMs}ms`
              : `Connection failed: ${testResult.error}`}
          </p>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          {provider !== 'mock' && (
            <Button variant="ghost" disabled={busy} onClick={() => void test()}>
              Test connection
            </Button>
          )}
          <Button disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save settings'}
          </Button>
        </div>

        {data?.settings?.lastTestedAt && (
          <p style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 12 }}>
            Last tested {new Date(data.settings.lastTestedAt).toLocaleString()} on{' '}
            <strong>{data.settings.lastTestedProvider}</strong>
            {data.settings.lastTestError && (
              <>
                {' '}
                ·{' '}
                <span style={{ color: tokens.color.danger }}>
                  failed: {data.settings.lastTestError}
                </span>
              </>
            )}
          </p>
        )}
      </Card>
    </div>
  );
}
