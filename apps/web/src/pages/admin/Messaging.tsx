// SPDX-License-Identifier: Elastic-2.0
//
// Messaging provider admin (v2 Sprint A, workstream 3.1). Replaces
// env-only config with self-service per-firm provider config. Credentials
// are encrypted at rest server-side and never returned as plaintext;
// reads return masked previews and a "configured" boolean. Editing
// requires re-submitting the secret.

import { useEffect, useState } from 'react';

import { Button, Card, Combobox, Pill, tokens } from '@vibe/ui';

import { api } from '../../api-client';

type EmailProvider = 'smtp' | 'postmark' | 'resend' | 'ses' | 'emailit';
type SmsProvider = 'textlink' | 'twilio' | 'sns';

interface MaskedEmail {
  provider: EmailProvider;
  from: string;
  host?: string;
  port?: number;
  secure?: boolean;
  userMasked?: string | null;
  passMasked?: string | null;
  tokenMasked?: string | null;
  apiKeyMasked?: string | null;
  region?: string;
  accessKeyIdMasked?: string | null;
  secretAccessKeyMasked?: string | null;
}

interface MaskedSms {
  provider: SmsProvider;
  from?: string;
  region?: string;
  apiKeyMasked?: string | null;
  accountSidMasked?: string | null;
  authTokenMasked?: string | null;
  accessKeyIdMasked?: string | null;
  secretAccessKeyMasked?: string | null;
}

interface MaskedVoice {
  provider: 'twilio';
  from: string;
  accountSidMasked: string | null;
  authTokenMasked: string | null;
  defaultVoice: string;
  language: string;
  windowStart: string;
  windowEnd: string;
}

interface SendResult {
  ok: boolean;
  error?: string;
  messageId?: string;
  providerMessageId?: string;
  callSid?: string;
}

// 0206 follow-up — recent voice-call outcomes.
interface VoiceCallRow {
  id: string;
  createdAt: string;
  kind: string;
  toNumber: string;
  status: string;
  fallbackSmsSent: boolean;
  clientName: string | null;
  error: string | null;
}

const CALL_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  answered: 'success',
  voicemail: 'success',
  busy: 'warning',
  no_answer: 'warning',
  failed: 'danger',
  opted_out: 'neutral',
  placed: 'neutral',
  queued: 'neutral',
  canceled: 'neutral',
  fallback_sms: 'warning',
};

// 0206 — automated voice calls (separate Twilio account from SMS).
interface VoiceDraft {
  from: string;
  accountSid: string;
  authToken: string;
  defaultVoice: string;
  language: string;
  windowStart: string;
  windowEnd: string;
}

const VOICE_OPTIONS = [
  'Polly.Joanna',
  'Polly.Matthew',
  'Polly.Salli',
  'Polly.Joey',
  'Polly.Kimberly',
  'Polly.Kendra',
  'Polly.Ivy',
  'alice',
  'man',
  'woman',
];

function emptyVoiceDraft(masked?: MaskedVoice | null): VoiceDraft {
  return {
    from: masked?.from ?? '',
    accountSid: '',
    authToken: '',
    defaultVoice: masked?.defaultVoice ?? 'Polly.Joanna',
    language: masked?.language ?? 'en-US',
    windowStart: masked?.windowStart ?? '09:00',
    windowEnd: masked?.windowEnd ?? '20:00',
  };
}

function buildVoiceBody(draft: VoiceDraft): unknown {
  return { provider: 'twilio', ...draft };
}

type EmailDraft =
  | {
      provider: 'smtp';
      from: string;
      host: string;
      port: string;
      secure: boolean;
      user: string;
      pass: string;
    }
  | { provider: 'postmark'; from: string; token: string }
  | { provider: 'resend'; from: string; apiKey: string }
  | { provider: 'emailit'; from: string; apiKey: string }
  | { provider: 'ses'; from: string; region: string; accessKeyId: string; secretAccessKey: string };

type SmsDraft =
  | { provider: 'textlink'; apiKey: string }
  | { provider: 'twilio'; from: string; accountSid: string; authToken: string }
  | { provider: 'sns'; region: string; accessKeyId: string; secretAccessKey: string };

function emptyEmailDraft(provider: EmailProvider): EmailDraft {
  switch (provider) {
    case 'smtp':
      return {
        provider: 'smtp',
        from: '',
        host: 'localhost',
        port: '1025',
        secure: false,
        user: '',
        pass: '',
      };
    case 'postmark':
      return { provider: 'postmark', from: '', token: '' };
    case 'resend':
      return { provider: 'resend', from: '', apiKey: '' };
    case 'emailit':
      return { provider: 'emailit', from: '', apiKey: '' };
    case 'ses':
      return {
        provider: 'ses',
        from: '',
        region: 'us-east-1',
        accessKeyId: '',
        secretAccessKey: '',
      };
  }
}

function emptySmsDraft(provider: SmsProvider): SmsDraft {
  switch (provider) {
    case 'textlink':
      return { provider: 'textlink', apiKey: '' };
    case 'twilio':
      return { provider: 'twilio', from: '', accountSid: '', authToken: '' };
    case 'sns':
      return { provider: 'sns', region: 'us-east-1', accessKeyId: '', secretAccessKey: '' };
  }
}

function buildEmailBody(draft: EmailDraft): unknown {
  switch (draft.provider) {
    case 'smtp':
      return {
        provider: 'smtp',
        from: draft.from,
        host: draft.host,
        port: Number(draft.port),
        secure: draft.secure,
        user: draft.user || undefined,
        pass: draft.pass || undefined,
      };
    case 'postmark':
    case 'resend':
    case 'emailit':
    case 'ses':
      return { ...draft };
  }
}

function buildSmsBody(draft: SmsDraft): unknown {
  return { ...draft };
}

// Surface the server's Zod validation issues so an invalid_email_config (or
// invalid_sms_config) tells the user exactly which field is wrong rather than
// just the opaque error code. ApiError carries the full response body.
function formatConfigError(e: unknown): string {
  const body = (
    e as {
      body?: { error?: string; issues?: Array<{ path?: (string | number)[]; message?: string }> };
    }
  ).body;
  if (body?.issues && Array.isArray(body.issues) && body.issues.length > 0) {
    const parts = body.issues.map(
      (i) => `${(i.path ?? []).join('.') || 'config'}: ${i.message ?? 'invalid'}`,
    );
    return `Invalid config — ${parts.join('; ')}`;
  }
  return e instanceof Error ? e.message : 'failed';
}

// For the "Test" buttons: only send the typed draft when its secret is
// actually filled in. After a save + reload the draft is reset to empty
// (the API only returns a masked config, never the secret), so sending it
// would fail validation — instead omit `config` so the server tests the
// saved/encrypted config it already has.
function smsTestConfig(draft: SmsDraft): unknown | undefined {
  switch (draft.provider) {
    case 'textlink':
      return draft.apiKey ? { ...draft } : undefined;
    case 'twilio':
      return draft.authToken ? { ...draft } : undefined;
    case 'sns':
      return draft.secretAccessKey ? { ...draft } : undefined;
  }
}

function emailTestConfig(draft: EmailDraft): unknown | undefined {
  switch (draft.provider) {
    case 'smtp':
      // SMTP may legitimately have no auth; treat host as the signal that
      // the user actually filled the draft in.
      return draft.host ? buildEmailBody(draft) : undefined;
    case 'postmark':
      return draft.token ? { ...draft } : undefined;
    case 'resend':
    case 'emailit':
      return draft.apiKey ? { ...draft } : undefined;
    case 'ses':
      return draft.secretAccessKey ? { ...draft } : undefined;
  }
}

const fieldStyle: React.CSSProperties = {
  padding: '8px 10px',
  background: tokens.color.surface,
  color: tokens.color.text,
  border: `1px solid ${tokens.color.border}`,
  borderRadius: tokens.radius.md,
  fontSize: 13,
};

const labelStyle: React.CSSProperties = { fontSize: 12, color: tokens.color.textMuted };

export function MessagingPage(): JSX.Element {
  const [email, setEmail] = useState<MaskedEmail | null>(null);
  const [sms, setSms] = useState<MaskedSms | null>(null);
  const [voice, setVoice] = useState<MaskedVoice | null>(null);
  const [emailDraft, setEmailDraft] = useState<EmailDraft>(emptyEmailDraft('smtp'));
  const [smsDraft, setSmsDraft] = useState<SmsDraft>(emptySmsDraft('textlink'));
  const [voiceDraft, setVoiceDraft] = useState<VoiceDraft>(emptyVoiceDraft());
  const [emailTo, setEmailTo] = useState('');
  const [smsTo, setSmsTo] = useState('');
  const [voiceTo, setVoiceTo] = useState('');
  const [emailStatus, setEmailStatus] = useState<string | null>(null);
  const [smsStatus, setSmsStatus] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
  const [recentCalls, setRecentCalls] = useState<VoiceCallRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function loadRecentCalls(): Promise<void> {
    try {
      const r = await api<{ items: VoiceCallRow[] }>('/api/staff/voice/calls?days=14');
      setRecentCalls(r.items ?? []);
    } catch {
      // Non-fatal — the card just stays empty.
    }
  }

  async function load(): Promise<void> {
    try {
      const r = await api<{
        email: MaskedEmail | null;
        sms: MaskedSms | null;
        voice: MaskedVoice | null;
      }>('/api/staff/admin/messaging');
      setEmail(r.email);
      setSms(r.sms);
      setVoice(r.voice);
      if (r.email) setEmailDraft(emptyEmailDraft(r.email.provider));
      if (r.sms) setSmsDraft(emptySmsDraft(r.sms.provider));
      if (r.voice) setVoiceDraft(emptyVoiceDraft(r.voice));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'load_failed');
    }
  }

  useEffect(() => {
    void load();
    void loadRecentCalls();
  }, []);

  async function saveEmail(): Promise<void> {
    setError(null);
    setEmailStatus(null);
    try {
      await api('/api/staff/admin/messaging/email', {
        method: 'PUT',
        body: JSON.stringify(buildEmailBody(emailDraft)),
      });
      setEmailStatus('Saved.');
      await load();
    } catch (e) {
      setError(formatConfigError(e));
    }
  }

  async function saveSms(): Promise<void> {
    setError(null);
    setSmsStatus(null);
    try {
      await api('/api/staff/admin/messaging/sms', {
        method: 'PUT',
        body: JSON.stringify(buildSmsBody(smsDraft)),
      });
      setSmsStatus('Saved.');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'save_failed');
    }
  }

  async function clearEmail(): Promise<void> {
    if (!confirm('Clear saved email provider config? Dispatcher will fall back to env vars.'))
      return;
    try {
      await api('/api/staff/admin/messaging/email', { method: 'DELETE' });
      setEmail(null);
      setEmailStatus('Cleared. Env defaults restored.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'clear_failed');
    }
  }

  async function clearSms(): Promise<void> {
    if (!confirm('Clear saved SMS provider config? Dispatcher will fall back to env vars.')) return;
    try {
      await api('/api/staff/admin/messaging/sms', { method: 'DELETE' });
      setSms(null);
      setSmsStatus('Cleared. Env defaults restored.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'clear_failed');
    }
  }

  async function testEmail(): Promise<void> {
    if (!emailTo) {
      setEmailStatus('Enter a recipient first.');
      return;
    }
    setEmailStatus('Sending…');
    try {
      const config = emailTestConfig(emailDraft);
      const r = await api<SendResult>('/api/staff/admin/messaging/email/test', {
        method: 'POST',
        body: JSON.stringify(config ? { to: emailTo, config } : { to: emailTo }),
      });
      setEmailStatus(
        r.ok ? `OK · messageId=${r.messageId ?? '(none)'}` : `Failed: ${r.error ?? 'unknown'}`,
      );
    } catch (e) {
      setEmailStatus(`Failed: ${formatConfigError(e)}`);
    }
  }

  async function saveVoice(): Promise<void> {
    setError(null);
    setVoiceStatus(null);
    try {
      await api('/api/staff/admin/messaging/voice', {
        method: 'PUT',
        body: JSON.stringify(buildVoiceBody(voiceDraft)),
      });
      setVoiceStatus('Saved.');
      await load();
    } catch (e) {
      setError(formatConfigError(e));
    }
  }

  async function clearVoice(): Promise<void> {
    if (!confirm('Clear saved voice config? Automated calls fall back to env vars (or off).'))
      return;
    try {
      await api('/api/staff/admin/messaging/voice', { method: 'DELETE' });
      setVoice(null);
      setVoiceStatus('Cleared.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'clear_failed');
    }
  }

  async function testVoice(): Promise<void> {
    if (!voiceTo) {
      setVoiceStatus('Enter a number to call first.');
      return;
    }
    setVoiceStatus('Placing call…');
    try {
      // Only pass the draft as a proposed config when the secret was typed.
      const config = voiceDraft.authToken ? buildVoiceBody(voiceDraft) : undefined;
      const r = await api<SendResult>('/api/staff/admin/messaging/voice/test', {
        method: 'POST',
        body: JSON.stringify(config ? { to: voiceTo, config } : { to: voiceTo }),
      });
      setVoiceStatus(r.ok ? `Calling… (sid ${r.callSid ?? 'n/a'})` : `Failed: ${r.error}`);
    } catch (e) {
      setVoiceStatus(`Failed: ${formatConfigError(e)}`);
    }
  }

  async function testSms(): Promise<void> {
    if (!smsTo) {
      setSmsStatus('Enter a recipient first.');
      return;
    }
    setSmsStatus('Sending…');
    try {
      const config = smsTestConfig(smsDraft);
      const r = await api<SendResult>('/api/staff/admin/messaging/sms/test', {
        method: 'POST',
        body: JSON.stringify(config ? { to: smsTo, config } : { to: smsTo }),
      });
      setSmsStatus(
        r.ok
          ? `OK · providerMessageId=${r.providerMessageId ?? '(none)'}`
          : `Failed: ${r.error ?? 'unknown'}`,
      );
    } catch (e) {
      setSmsStatus(e instanceof Error ? `Failed: ${e.message}` : 'Failed');
    }
  }

  return (
    <div style={{ display: 'grid', gap: tokens.space.lg, maxWidth: 900 }}>
      {error && (
        <p style={{ color: tokens.color.danger, fontSize: 12 }} role="alert">
          {error}
        </p>
      )}

      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>Email provider</span>
            {email ? (
              <Pill tone="success">{email.provider} configured</Pill>
            ) : (
              <Pill tone="neutral">Using env defaults</Pill>
            )}
          </span>
        }
      >
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 12 }}>
          Choose a provider and supply credentials. Saved credentials are encrypted at rest. Test
          before saving to verify connectivity. Clearing restores env-var defaults.
        </p>
        <div style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
          <span style={labelStyle}>Provider</span>
          <Combobox
            ariaLabel="Email provider"
            value={emailDraft.provider}
            onChange={(v) => setEmailDraft(emptyEmailDraft(v as EmailProvider))}
            options={[
              { value: 'smtp', label: 'SMTP' },
              { value: 'postmark', label: 'Postmark' },
              { value: 'resend', label: 'Resend' },
              { value: 'emailit', label: 'EmailIt' },
              { value: 'ses', label: 'AWS SES' },
            ]}
          />
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>From address</span>
            <input
              value={emailDraft.from}
              onChange={(e) => setEmailDraft({ ...emailDraft, from: e.target.value })}
              placeholder="Vibe Practice Management <[email protected]>"
              style={fieldStyle}
            />
          </label>

          {emailDraft.provider === 'smtp' && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Host</span>
                  <input
                    value={emailDraft.host}
                    onChange={(e) => setEmailDraft({ ...emailDraft, host: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Port</span>
                  <input
                    value={emailDraft.port}
                    onChange={(e) => setEmailDraft({ ...emailDraft, port: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
              </div>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={emailDraft.secure}
                  onChange={(e) => setEmailDraft({ ...emailDraft, secure: e.target.checked })}
                />
                TLS (secure)
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>User</span>
                  <input
                    value={emailDraft.user}
                    onChange={(e) => setEmailDraft({ ...emailDraft, user: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Password</span>
                  <input
                    type="password"
                    value={emailDraft.pass}
                    onChange={(e) => setEmailDraft({ ...emailDraft, pass: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
              </div>
            </>
          )}

          {emailDraft.provider === 'postmark' && (
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>Server token</span>
              <input
                type="password"
                value={emailDraft.token}
                onChange={(e) => setEmailDraft({ ...emailDraft, token: e.target.value })}
                style={fieldStyle}
              />
            </label>
          )}

          {(emailDraft.provider === 'resend' || emailDraft.provider === 'emailit') && (
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>API key</span>
              <input
                type="password"
                value={emailDraft.apiKey}
                onChange={(e) => setEmailDraft({ ...emailDraft, apiKey: e.target.value })}
                style={fieldStyle}
              />
            </label>
          )}

          {emailDraft.provider === 'ses' && (
            <>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={labelStyle}>Region</span>
                <input
                  value={emailDraft.region}
                  onChange={(e) => setEmailDraft({ ...emailDraft, region: e.target.value })}
                  style={fieldStyle}
                />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Access key ID</span>
                  <input
                    type="password"
                    value={emailDraft.accessKeyId}
                    onChange={(e) => setEmailDraft({ ...emailDraft, accessKeyId: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Secret access key</span>
                  <input
                    type="password"
                    value={emailDraft.secretAccessKey}
                    onChange={(e) =>
                      setEmailDraft({ ...emailDraft, secretAccessKey: e.target.value })
                    }
                    style={fieldStyle}
                  />
                </label>
              </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              placeholder="Test recipient ([email protected])"
              style={{ ...fieldStyle, flex: 1 }}
            />
            <Button variant="secondary" onClick={() => void testEmail()}>
              Send test
            </Button>
            <Button onClick={() => void saveEmail()}>Save</Button>
            {email && (
              <Button variant="ghost" onClick={() => void clearEmail()}>
                Clear
              </Button>
            )}
          </div>
          {emailStatus && (
            <p style={{ fontSize: 12, color: tokens.color.textMuted }}>{emailStatus}</p>
          )}
        </div>
      </Card>

      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>SMS provider</span>
            {sms ? (
              <Pill tone="success">{sms.provider} configured</Pill>
            ) : (
              <Pill tone="neutral">Using env defaults</Pill>
            )}
          </span>
        }
      >
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 12 }}>
          Choose a provider and supply credentials. Test recipients should be in E.164 format (e.g.
          +12025551212).
        </p>
        <div style={{ display: 'grid', gap: 4, marginBottom: 12 }}>
          <span style={labelStyle}>Provider</span>
          <Combobox
            ariaLabel="SMS provider"
            value={smsDraft.provider}
            onChange={(v) => setSmsDraft(emptySmsDraft(v as SmsProvider))}
            options={[
              { value: 'textlink', label: 'TextLink' },
              { value: 'twilio', label: 'Twilio' },
              { value: 'sns', label: 'AWS SNS' },
            ]}
          />
        </div>

        <div style={{ display: 'grid', gap: 8 }}>
          {smsDraft.provider === 'textlink' && (
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>API key</span>
              <input
                type="password"
                value={smsDraft.apiKey}
                onChange={(e) => setSmsDraft({ ...smsDraft, apiKey: e.target.value })}
                style={fieldStyle}
              />
            </label>
          )}

          {smsDraft.provider === 'twilio' && (
            <>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={labelStyle}>From number (E.164)</span>
                <input
                  value={smsDraft.from}
                  onChange={(e) => setSmsDraft({ ...smsDraft, from: e.target.value })}
                  placeholder="+12025551212"
                  style={fieldStyle}
                />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Account SID</span>
                  <input
                    type="password"
                    value={smsDraft.accountSid}
                    onChange={(e) => setSmsDraft({ ...smsDraft, accountSid: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Auth token</span>
                  <input
                    type="password"
                    value={smsDraft.authToken}
                    onChange={(e) => setSmsDraft({ ...smsDraft, authToken: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
              </div>
            </>
          )}

          {smsDraft.provider === 'sns' && (
            <>
              <label style={{ display: 'grid', gap: 4 }}>
                <span style={labelStyle}>Region</span>
                <input
                  value={smsDraft.region}
                  onChange={(e) => setSmsDraft({ ...smsDraft, region: e.target.value })}
                  style={fieldStyle}
                />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Access key ID</span>
                  <input
                    type="password"
                    value={smsDraft.accessKeyId}
                    onChange={(e) => setSmsDraft({ ...smsDraft, accessKeyId: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
                <label style={{ display: 'grid', gap: 4 }}>
                  <span style={labelStyle}>Secret access key</span>
                  <input
                    type="password"
                    value={smsDraft.secretAccessKey}
                    onChange={(e) => setSmsDraft({ ...smsDraft, secretAccessKey: e.target.value })}
                    style={fieldStyle}
                  />
                </label>
              </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input
              value={smsTo}
              onChange={(e) => setSmsTo(e.target.value)}
              placeholder="Test recipient (+12025551212)"
              style={{ ...fieldStyle, flex: 1 }}
            />
            <Button variant="secondary" onClick={() => void testSms()}>
              Send test
            </Button>
            <Button onClick={() => void saveSms()}>Save</Button>
            {sms && (
              <Button variant="ghost" onClick={() => void clearSms()}>
                Clear
              </Button>
            )}
          </div>
          {smsStatus && <p style={{ fontSize: 12, color: tokens.color.textMuted }}>{smsStatus}</p>}
        </div>
      </Card>

      <Card
        title={
          <span style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <span>Voice calls (Twilio)</span>
            {voice ? (
              <Pill tone="success">configured</Pill>
            ) : (
              <Pill tone="neutral">Not configured</Pill>
            )}
          </span>
        }
      >
        <p style={{ fontSize: 12, color: tokens.color.textMuted, marginBottom: 12 }}>
          A separate Twilio account for automated voice calls — appointment reminders and status
          notifications with a CALL channel. Calls only place inside the calling window; clients can
          press 9 on any call to opt out (they get texts instead), and unanswered calls fall back to
          SMS automatically.
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={labelStyle}>From number (E.164, voice-capable)</span>
            <input
              value={voiceDraft.from}
              onChange={(e) => setVoiceDraft({ ...voiceDraft, from: e.target.value })}
              placeholder="+12025551212"
              style={fieldStyle}
            />
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>
                Account SID{voice?.accountSidMasked ? ` (saved: ${voice.accountSidMasked})` : ''}
              </span>
              <input
                type="password"
                value={voiceDraft.accountSid}
                onChange={(e) => setVoiceDraft({ ...voiceDraft, accountSid: e.target.value })}
                style={fieldStyle}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>
                Auth token{voice?.authTokenMasked ? ` (saved: ${voice.authTokenMasked})` : ''}
              </span>
              <input
                type="password"
                value={voiceDraft.authToken}
                onChange={(e) => setVoiceDraft({ ...voiceDraft, authToken: e.target.value })}
                style={fieldStyle}
              />
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>Default voice</span>
              <Combobox
                ariaLabel="Default voice"
                value={voiceDraft.defaultVoice}
                onChange={(v) => setVoiceDraft({ ...voiceDraft, defaultVoice: v })}
                options={VOICE_OPTIONS.map((v) => ({ value: v, label: v }))}
              />
            </div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>Language</span>
              <input
                value={voiceDraft.language}
                onChange={(e) => setVoiceDraft({ ...voiceDraft, language: e.target.value })}
                placeholder="en-US"
                style={fieldStyle}
              />
            </label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>Calling window start</span>
              <input
                type="time"
                value={voiceDraft.windowStart}
                onChange={(e) => setVoiceDraft({ ...voiceDraft, windowStart: e.target.value })}
                style={fieldStyle}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={labelStyle}>Calling window end</span>
              <input
                type="time"
                value={voiceDraft.windowEnd}
                onChange={(e) => setVoiceDraft({ ...voiceDraft, windowEnd: e.target.value })}
                style={fieldStyle}
              />
            </label>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
            <input
              value={voiceTo}
              onChange={(e) => setVoiceTo(e.target.value)}
              placeholder="Test call number (+12025551212)"
              style={{ ...fieldStyle, flex: 1 }}
            />
            <Button variant="secondary" onClick={() => void testVoice()}>
              Test call
            </Button>
            <Button onClick={() => void saveVoice()}>Save</Button>
            {voice && (
              <Button variant="ghost" onClick={() => void clearVoice()}>
                Clear
              </Button>
            )}
          </div>
          {voiceStatus && (
            <p style={{ fontSize: 12, color: tokens.color.textMuted }}>{voiceStatus}</p>
          )}
        </div>
      </Card>

      <Card
        title="Recent voice calls (14 days)"
        action={
          <Button size="sm" variant="ghost" onClick={() => void loadRecentCalls()}>
            Refresh
          </Button>
        }
      >
        {recentCalls.length === 0 ? (
          <p style={{ fontSize: 13, color: tokens.color.textMuted }}>No automated calls yet.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr>
                {['When', 'Client', 'Kind', 'To', 'Outcome', ''].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      padding: '6px 8px',
                      color: tokens.color.textMuted,
                      fontSize: 11,
                      borderBottom: `1px solid ${tokens.color.border}`,
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {recentCalls.map((c) => (
                <tr key={c.id}>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                    {new Date(c.createdAt).toLocaleString()}
                  </td>
                  <td style={{ padding: '6px 8px' }}>{c.clientName ?? '—'}</td>
                  <td style={{ padding: '6px 8px' }}>
                    {c.kind === 'appointment_reminder'
                      ? 'Appt reminder'
                      : c.kind.startsWith('engagement_status:')
                        ? `Status: ${c.kind.slice('engagement_status:'.length)}`
                        : c.kind}
                  </td>
                  <td style={{ padding: '6px 8px', fontFamily: tokens.font.mono, fontSize: 12 }}>
                    {c.toNumber}
                  </td>
                  <td style={{ padding: '6px 8px' }} title={c.error ?? undefined}>
                    <Pill tone={CALL_STATUS_TONE[c.status] ?? 'neutral'}>
                      {c.status.replace('_', ' ')}
                    </Pill>
                  </td>
                  <td style={{ padding: '6px 8px', fontSize: 11, color: tokens.color.textMuted }}>
                    {c.fallbackSmsSent ? 'fell back to SMS' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
