// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0233 — thin Twilio REST client for the two-way SMS inbox. Raw fetch +
// Basic auth in the same style as sms/provider.ts (no SDK, zod-free so the
// worker can import it). Covers exactly what the inbox needs: Messaging
// Service sends, message lookup + listing (polling reconciler), media
// fetch/delete (MMS intake), Messaging Service numbers, A2P status.

import type { Logger } from 'pino';

export interface TwilioClientOptions {
  accountSid: string;
  authToken: string;
  apiKeySid?: string;
  apiKeySecret?: string;
  fetchImpl?: typeof fetch;
}

export class TwilioApiError extends Error {
  readonly status: number;
  readonly code: number | null;
  readonly retryable: boolean;
  constructor(message: string, status: number, code: number | null) {
    super(message);
    this.name = 'TwilioApiError';
    this.status = status;
    this.code = code;
    // 429 / 5xx / Twilio's own "too many requests" code are worth retrying;
    // 4xx validation errors are not.
    this.retryable = status === 429 || status >= 500 || code === 20429;
  }
}

export interface TwilioMessage {
  sid: string;
  from: string;
  to: string;
  body: string;
  status: string;
  direction: string; // inbound | outbound-api | outbound-call | outbound-reply
  numSegments: number;
  numMedia: number;
  errorCode: number | null;
  errorMessage: string | null;
  dateSent: Date | null;
  dateCreated: Date | null;
  messagingServiceSid: string | null;
  /** relative subresource uri for media listing */
  mediaUri: string | null;
}

export interface TwilioMedia {
  sid: string;
  contentType: string;
  /** absolute URL (api.twilio.com …/Media/{sid}) */
  url: string;
}

export type TwilioA2pStatus = 'registered' | 'pending' | 'unregistered' | 'unknown';

export interface TwilioClient {
  sendMessage(args: {
    to: string;
    body: string;
    messagingServiceSid?: string;
    from?: string;
    statusCallback?: string;
    mediaUrls?: string[];
  }): Promise<{ sid: string; status: string; numSegments: number }>;
  getMessage(sid: string): Promise<TwilioMessage>;
  listMessages(args: {
    to?: string;
    from?: string;
    dateSentAfter?: Date;
    pageSize?: number;
    maxPages?: number;
  }): AsyncIterable<TwilioMessage>;
  listMedia(messageSid: string): Promise<TwilioMedia[]>;
  fetchMedia(url: string): Promise<{ bytes: Buffer; contentType: string }>;
  deleteMedia(messageSid: string, mediaSid: string): Promise<void>;
  listMessagingServicePhoneNumbers(
    serviceSid: string,
  ): Promise<Array<{ sid: string; phoneNumber: string }>>;
  getMessagingService(serviceSid: string): Promise<{ sid: string; friendlyName: string }>;
  getA2pStatus(serviceSid: string): Promise<TwilioA2pStatus>;
  verifyCredentials(): Promise<{ ok: boolean; accountName?: string; error?: string }>;
}

const API = 'https://api.twilio.com';
const MESSAGING = 'https://messaging.twilio.com';

function parseDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toInt(v: unknown, fallback = 0): number {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function mapMessage(j: Record<string, unknown>): TwilioMessage {
  const sub = (j['subresource_uris'] ?? {}) as Record<string, unknown>;
  return {
    sid: String(j['sid'] ?? ''),
    from: String(j['from'] ?? ''),
    to: String(j['to'] ?? ''),
    body: typeof j['body'] === 'string' ? j['body'] : '',
    status: String(j['status'] ?? ''),
    direction: String(j['direction'] ?? ''),
    numSegments: toInt(j['num_segments'], 1),
    numMedia: toInt(j['num_media'], 0),
    errorCode: j['error_code'] == null ? null : toInt(j['error_code'], 0) || null,
    errorMessage: typeof j['error_message'] === 'string' ? j['error_message'] : null,
    dateSent: parseDate(j['date_sent']),
    dateCreated: parseDate(j['date_created']),
    messagingServiceSid:
      typeof j['messaging_service_sid'] === 'string' ? j['messaging_service_sid'] : null,
    mediaUri: typeof sub['media'] === 'string' ? sub['media'] : null,
  };
}

/** Twilio's "YYYY-MM-DDThh:mm:ssZ" filter format (ISO without millis). */
function twilioDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function createTwilioClient(opts: TwilioClientOptions, log: Logger): TwilioClient {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as typeof fetch);
  const user = opts.apiKeySid && opts.apiKeySecret ? opts.apiKeySid : opts.accountSid;
  const pass = opts.apiKeySid && opts.apiKeySecret ? opts.apiKeySecret : opts.authToken;
  const authHeader = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  const acct = `${API}/2010-04-01/Accounts/${opts.accountSid}`;

  async function call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    form?: URLSearchParams,
  ): Promise<T> {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? form.toString() : undefined,
    });
    if (res.status === 204) return undefined as T;
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON body; fall through to status handling */
    }
    if (!res.ok) {
      const code = json['code'] == null ? null : toInt(json['code'], 0) || null;
      const message =
        typeof json['message'] === 'string' ? json['message'] : `twilio ${res.status}`;
      throw new TwilioApiError(message, res.status, code);
    }
    return json as T;
  }

  return {
    async sendMessage(args) {
      const form = new URLSearchParams({ To: args.to, Body: args.body });
      if (args.messagingServiceSid) form.set('MessagingServiceSid', args.messagingServiceSid);
      else if (args.from) form.set('From', args.from);
      else throw new TwilioApiError('no From number or Messaging Service configured', 400, null);
      if (args.statusCallback) form.set('StatusCallback', args.statusCallback);
      for (const m of args.mediaUrls ?? []) form.append('MediaUrl', m);
      const j = await call<Record<string, unknown>>('POST', `${acct}/Messages.json`, form);
      return {
        sid: String(j['sid'] ?? ''),
        status: String(j['status'] ?? 'queued'),
        numSegments: toInt(j['num_segments'], 1),
      };
    },

    async getMessage(sid) {
      const j = await call<Record<string, unknown>>('GET', `${acct}/Messages/${sid}.json`);
      return mapMessage(j);
    },

    listMessages(args) {
      const pageSize = args.pageSize ?? 100;
      const maxPages = args.maxPages ?? 20;
      const qs = new URLSearchParams({ PageSize: String(pageSize) });
      if (args.to) qs.set('To', args.to);
      if (args.from) qs.set('From', args.from);
      if (args.dateSentAfter) qs.set('DateSent>', twilioDate(args.dateSentAfter));
      let next: string | null = `${acct}/Messages.json?${qs.toString()}`;
      let pages = 0;
      return {
        async *[Symbol.asyncIterator]() {
          while (next && pages < maxPages) {
            const j: Record<string, unknown> = await call('GET', next);
            pages += 1;
            const items = Array.isArray(j['messages'])
              ? (j['messages'] as Record<string, unknown>[])
              : [];
            for (const m of items) yield mapMessage(m);
            const nextUri = typeof j['next_page_uri'] === 'string' ? j['next_page_uri'] : null;
            next = nextUri ? `${API}${nextUri}` : null;
          }
        },
      };
    },

    async listMedia(messageSid) {
      const j = await call<Record<string, unknown>>(
        'GET',
        `${acct}/Messages/${messageSid}/Media.json`,
      );
      const list = Array.isArray(j['media_list'])
        ? (j['media_list'] as Record<string, unknown>[])
        : [];
      return list.map((m) => ({
        sid: String(m['sid'] ?? ''),
        contentType: String(m['content_type'] ?? 'application/octet-stream'),
        url: `${acct}/Messages/${messageSid}/Media/${String(m['sid'] ?? '')}`,
      }));
    },

    // Media lives behind an auth-gated api.twilio.com URL that 302/307s to
    // a short-lived S3 link. Send credentials ONLY to api.twilio.com; follow
    // the redirect manually WITHOUT the Authorization header (S3 rejects
    // foreign auth headers, and we must never leak the token to a third
    // party host).
    async fetchMedia(url) {
      let target = url;
      let authed = /^https:\/\/api\.twilio\.com\//.test(url);
      for (let hop = 0; hop < 4; hop++) {
        const res = await fetchImpl(target, {
          method: 'GET',
          redirect: 'manual',
          headers: authed ? { Authorization: authHeader } : {},
        });
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) throw new TwilioApiError('media redirect without location', res.status, null);
          target = new URL(loc, target).toString();
          authed = /^https:\/\/api\.twilio\.com\//.test(target);
          continue;
        }
        if (!res.ok) throw new TwilioApiError(`media fetch ${res.status}`, res.status, null);
        const bytes = Buffer.from(await res.arrayBuffer());
        const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
        return { bytes, contentType: contentType.split(';')[0]!.trim() };
      }
      throw new TwilioApiError('too many media redirects', 508, null);
    },

    async deleteMedia(messageSid, mediaSid) {
      await call<undefined>('DELETE', `${acct}/Messages/${messageSid}/Media/${mediaSid}.json`);
    },

    async listMessagingServicePhoneNumbers(serviceSid) {
      const out: Array<{ sid: string; phoneNumber: string }> = [];
      let next: string | null = `${MESSAGING}/v1/Services/${serviceSid}/PhoneNumbers?PageSize=100`;
      let pages = 0;
      while (next && pages < 10) {
        const j: Record<string, unknown> = await call('GET', next);
        pages += 1;
        const items = Array.isArray(j['phone_numbers'])
          ? (j['phone_numbers'] as Record<string, unknown>[])
          : [];
        for (const p of items) {
          out.push({ sid: String(p['sid'] ?? ''), phoneNumber: String(p['phone_number'] ?? '') });
        }
        const meta = (j['meta'] ?? {}) as Record<string, unknown>;
        next = typeof meta['next_page_url'] === 'string' ? meta['next_page_url'] : null;
      }
      return out;
    },

    async getMessagingService(serviceSid) {
      const j = await call<Record<string, unknown>>(
        'GET',
        `${MESSAGING}/v1/Services/${serviceSid}`,
      );
      return { sid: String(j['sid'] ?? ''), friendlyName: String(j['friendly_name'] ?? '') };
    },

    // US A2P 10DLC: a Messaging Service is deliverable to US long codes once
    // it carries a VERIFIED campaign. Anything unexpected → 'unknown' so a
    // transient API problem never blocks sending.
    async getA2pStatus(serviceSid) {
      try {
        const j = await call<Record<string, unknown>>(
          'GET',
          `${MESSAGING}/v1/Services/${serviceSid}/Compliance/Usa2p`,
        );
        const items = Array.isArray(j['compliance'])
          ? (j['compliance'] as Record<string, unknown>[])
          : [];
        if (items.length === 0) return 'unregistered';
        const statuses = items.map((c) => String(c['campaign_status'] ?? '').toUpperCase());
        if (statuses.some((s) => s === 'VERIFIED')) return 'registered';
        if (statuses.some((s) => s === 'IN_PROGRESS' || s === 'PENDING')) return 'pending';
        return 'unregistered';
      } catch (err) {
        log.warn({ err }, 'twilio a2p status lookup failed');
        return 'unknown';
      }
    },

    async verifyCredentials() {
      try {
        const j = await call<Record<string, unknown>>('GET', `${acct}.json`);
        return { ok: true, accountName: String(j['friendly_name'] ?? '') };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'verify_failed' };
      }
    },
  };
}
