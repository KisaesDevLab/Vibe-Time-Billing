// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// 0224 — one helper every report page uses to download itself as a
// native PDF (server-rendered print document via /api/staff/reports/pdf).
// Pages send pre-formatted string cells so the PDF matches the table.

import { getCsrfToken } from '../api-client';

export interface ReportPdfColumn {
  label: string;
  sub?: string;
  align?: 'left' | 'right';
  width?: string;
}

export interface ReportPdfRequest {
  title: string;
  subtitle?: string;
  columns: ReportPdfColumn[];
  rows: string[][];
  totals?: string[];
  totalsLabel?: string;
  groupHeaders?: { start: number; span: number; label: string }[];
  orientation?: 'portrait' | 'landscape';
}

export async function downloadReportPdf(req: ReportPdfRequest): Promise<void> {
  const csrf = getCsrfToken();
  const res = await fetch('/api/staff/reports/pdf', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`pdf_failed_${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${req.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'report'}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
