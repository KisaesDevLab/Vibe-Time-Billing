// SPDX-License-Identifier: Elastic-2.0
//
// Thin HTTP client for the Vibe Print gateway. The base URL is a
// firm-configured trusted LAN address, so (unlike the Puppeteer asset
// fetch in pdf/render.ts) no SSRF guard is applied here.

import type { ResolvedPrintGateway } from './config';

export interface GatewayPrinter {
  id: number;
  name: string;
}

export interface PrintPdfInput {
  printerId: number;
  pdf: Buffer;
  copies?: number;
  media?: string | null;
  idempotencyKey?: string | null;
}

export interface PrintPdfResult {
  jobId: string | null;
  raw: unknown;
}

const DEFAULT_TIMEOUT_MS = 15_000;

type FetchImpl = typeof fetch;

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

/** GET /v1/printers — for the printer picker. */
export async function listPrinters(
  cfg: ResolvedPrintGateway,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<GatewayPrinter[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
    f(`${cfg.baseUrl}/v1/printers`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal,
    }),
  );
  if (!res.ok) {
    throw new Error(`gateway_list_failed_${res.status}`);
  }
  const body = (await res.json()) as unknown;
  const arr = Array.isArray(body)
    ? body
    : Array.isArray((body as { printers?: unknown[] })?.printers)
      ? (body as { printers: unknown[] }).printers
      : [];
  return arr
    .map((p) => {
      const r = p as { id?: unknown; name?: unknown };
      return { id: Number(r.id), name: String(r.name ?? '') };
    })
    .filter((p) => Number.isFinite(p.id));
}

/** POST /v1/print/file — send an already-rendered PDF to a printer. */
export async function printPdf(
  cfg: ResolvedPrintGateway,
  input: PrintPdfInput,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<PrintPdfResult> {
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  const res = await withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
    f(`${cfg.baseUrl}/v1/print/file`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        printer: input.printerId,
        content: input.pdf.toString('base64'),
        content_type: 'pdf',
        copies: input.copies ?? 1,
        ...(input.media ? { media: input.media } : {}),
      }),
    }),
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `gateway_print_failed_${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const jobId =
    raw['id'] != null ? String(raw['id']) : raw['job_id'] != null ? String(raw['job_id']) : null;
  return { jobId, raw };
}

export interface GatewayTemplate {
  id: number;
  name: string;
}

/** GET /v1/admin/templates — gateway-side PDF/HTML templates, for the
 *  signature-print rule editor. */
export async function listTemplates(
  cfg: ResolvedPrintGateway,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<GatewayTemplate[]> {
  const f = opts.fetchImpl ?? fetch;
  const res = await withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
    f(`${cfg.baseUrl}/v1/admin/templates`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      signal,
    }),
  );
  if (!res.ok) {
    throw new Error(`gateway_templates_failed_${res.status}`);
  }
  const body = (await res.json()) as unknown;
  const arr = Array.isArray(body)
    ? body
    : Array.isArray((body as { templates?: unknown[] })?.templates)
      ? (body as { templates: unknown[] }).templates
      : [];
  return arr
    .map((t) => {
      const r = t as { id?: unknown; name?: unknown };
      return { id: Number(r.id), name: String(r.name ?? '') };
    })
    .filter((t) => Number.isFinite(t.id));
}

export interface PrintTemplateInput {
  printerId: number;
  templateId: number;
  data: Record<string, unknown>;
  copies?: number;
  idempotencyKey?: string | null;
}

/** POST /v1/print — render a gateway template from `data` and print it. */
export async function printWithTemplate(
  cfg: ResolvedPrintGateway,
  input: PrintTemplateInput,
  opts: { fetchImpl?: FetchImpl; timeoutMs?: number } = {},
): Promise<PrintPdfResult> {
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  if (input.idempotencyKey) headers['Idempotency-Key'] = input.idempotencyKey;
  const res = await withTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, (signal) =>
    f(`${cfg.baseUrl}/v1/print`, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        printer: input.printerId,
        template: input.templateId,
        data: input.data,
        copies: input.copies ?? 1,
      }),
    }),
  );
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `gateway_print_failed_${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    );
  }
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const jobId =
    raw['id'] != null ? String(raw['id']) : raw['job_id'] != null ? String(raw['job_id']) : null;
  return { jobId, raw };
}
