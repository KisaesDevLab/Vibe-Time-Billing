// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Per-report-kind parameter contracts. Used to (a) prompt the model with the
// exact parameter shape it may emit for a saved report and (b) validate what
// it returns before it's persisted. Mirrors the UI's ParamSpec in the web
// ReportViewer, but kept server-side so AI-generated params are checked.

import { z } from 'zod';

export interface ParamField {
  name: string;
  type: 'number' | 'date' | 'enum' | 'string';
  description: string;
  enum?: readonly string[];
}

interface KindSpec {
  description: string;
  fields: ParamField[];
  schema: z.ZodType<Record<string, unknown>>;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE);

const START_FIELD: ParamField = {
  name: 'start',
  type: 'date',
  description: 'Inclusive start date YYYY-MM-DD.',
};
const END_FIELD: ParamField = {
  name: 'end',
  type: 'date',
  description: 'Inclusive end date YYYY-MM-DD.',
};
const BASIS_FIELD: ParamField = {
  name: 'basis',
  type: 'enum',
  enum: ['accrual', 'cash'],
  description:
    'Revenue basis: accrual = amounts billed (invoice issue date), cash = amounts actually collected (payment receipt date).',
};

// Spec for a report that takes an optional start/end window (and optionally
// the accrual/cash basis toggle).
function dateWindowSpec(description: string, opts: { basis?: boolean } = {}): KindSpec {
  return {
    description,
    fields: [START_FIELD, END_FIELD, ...(opts.basis ? [BASIS_FIELD] : [])],
    schema: z
      .object({
        start: dateField.optional(),
        end: dateField.optional(),
        ...(opts.basis ? { basis: z.enum(['accrual', 'cash']).optional() } : {}),
      })
      .strict(),
  };
}

export const REPORT_PARAM_SPECS: Record<string, KindSpec> = {
  realization: {
    description: 'Write-up / write-down realization rollup.',
    fields: [
      {
        name: 'dimension',
        type: 'enum',
        enum: ['firm', 'timekeeper', 'engagement', 'client', 'service_line'],
        description: 'How to group the rollup.',
      },
      { name: 'start', type: 'date', description: 'Inclusive start date YYYY-MM-DD.' },
      { name: 'end', type: 'date', description: 'Inclusive end date YYYY-MM-DD.' },
    ],
    schema: z
      .object({
        dimension: z
          .enum(['firm', 'timekeeper', 'engagement', 'client', 'service_line'])
          .optional(),
        start: dateField.optional(),
        end: dateField.optional(),
      })
      .strict(),
  },
  'capacity-forecast': {
    description: 'Projected billable hours vs target.',
    fields: [
      { name: 'weeklyTarget', type: 'number', description: 'Target billable hours/week.' },
      START_FIELD,
      END_FIELD,
    ],
    schema: z
      .object({
        weeklyTarget: z.number().positive().optional(),
        start: dateField.optional(),
        end: dateField.optional(),
      })
      .strict(),
  },
  'productivity-by-office': {
    description: 'Hours and utilization per office.',
    fields: [{ name: 'days', type: 'number', description: 'Trailing window in days (1–365).' }],
    schema: z.object({ days: z.number().int().min(1).max(365).optional() }).strict(),
  },
  'billable-targets': {
    description: 'Billable hours vs the monthly target.',
    fields: [{ name: 'target', type: 'number', description: 'Override monthly target hours.' }],
    schema: z.object({ target: z.number().positive().optional() }).strict(),
  },
  'subscription-profitability': {
    description: 'Retainer revenue vs cost-to-serve.',
    fields: [
      { name: 'days', type: 'number', description: 'Trailing window in days (30–365).' },
      { ...START_FIELD, description: 'Window start YYYY-MM-DD (alternative to days).' },
    ],
    schema: z
      .object({
        days: z.number().int().min(30).max(365).optional(),
        start: dateField.optional(),
      })
      .strict(),
  },
  'client-request-capture': {
    description: 'Billable time captured against fulfilled client requests.',
    fields: [
      { name: 'start', type: 'date', description: 'Inclusive start YYYY-MM-DD.' },
      { name: 'end', type: 'date', description: 'Inclusive end YYYY-MM-DD.' },
    ],
    schema: z.object({ start: dateField.optional(), end: dateField.optional() }).strict(),
  },
  dso: {
    description: 'Days sales outstanding + collection rate.',
    fields: [{ name: 'days', type: 'number', description: 'Trailing window in days (30–365).' }],
    schema: z.object({ days: z.number().int().min(30).max(365).optional() }).strict(),
  },
};

// Windowed reports (previously mislabeled NO_PARAM, which prevented AI-
// suggested saved reports from ever carrying a date range the backend
// actually supports). `basis: true` marks the reports with the accrual/cash
// collection toggle.
REPORT_PARAM_SPECS['profitability'] = dateWindowSpec('Profit per engagement.', { basis: true });
REPORT_PARAM_SPECS['firm-profitability'] = dateWindowSpec(
  'Firm-wide engagement cost/revenue/margin.',
  { basis: true },
);
REPORT_PARAM_SPECS['revenue-by-month'] = dateWindowSpec('Monthly revenue.', { basis: true });
REPORT_PARAM_SPECS['revenue-period-over-period'] = dateWindowSpec(
  'Month-over-month revenue change.',
  { basis: true },
);
REPORT_PARAM_SPECS['collection-realization'] = dateWindowSpec(
  'Collections vs billings per partner.',
  { basis: true },
);
REPORT_PARAM_SPECS['book-of-business'] = dateWindowSpec('Partner book of business.', {
  basis: true,
});
REPORT_PARAM_SPECS['utilization'] = dateWindowSpec('Billable vs total hours per timekeeper.');
REPORT_PARAM_SPECS['non-billable-breakdown'] = dateWindowSpec(
  'Non-billable hours by work code (CPE, meetings, marketing …).',
);
REPORT_PARAM_SPECS['effective-rate'] = dateWindowSpec('Billed value per billable hour.');
REPORT_PARAM_SPECS['scope-creep'] = dateWindowSpec('Out-of-scope hours on mixed engagements.');
REPORT_PARAM_SPECS['realization-by-partner'] = dateWindowSpec('Realization per partner.');
REPORT_PARAM_SPECS['time-by-staff-week'] = dateWindowSpec(
  'Weekly Mon–Sun hours grid per staff member.',
);
REPORT_PARAM_SPECS['time-by-engagement'] = dateWindowSpec('Hours + value per engagement.');
REPORT_PARAM_SPECS['time-by-client'] = dateWindowSpec('Hours + value per client.');
REPORT_PARAM_SPECS['time-anomalies'] = dateWindowSpec('Outlier daily-hours detection.');
REPORT_PARAM_SPECS['approval-metrics'] = {
  description: 'Approval throughput per approver.',
  fields: [{ name: 'days', type: 'number', description: 'Trailing window in days (7–365).' }],
  schema: z.object({ days: z.number().int().min(7).max(365).optional() }).strict(),
};

// Report kinds that genuinely take no parameters — the only valid output is {}.
const NO_PARAM_KINDS = ['mrr', 'clv'];
for (const k of NO_PARAM_KINDS) {
  REPORT_PARAM_SPECS[k] = {
    description: `${k} report.`,
    fields: [],
    schema: z.object({}).strict(),
  };
}

/** Human-readable description of a kind's allowed params, for the AI prompt. */
export function paramSpecPrompt(kind: string): string | null {
  const spec = REPORT_PARAM_SPECS[kind];
  if (!spec) return null;
  if (spec.fields.length === 0) return `Report "${kind}" takes NO parameters. Return exactly {}.`;
  const lines = spec.fields.map((f) => {
    const t = f.type === 'enum' ? `one of ${JSON.stringify(f.enum)}` : f.type;
    return `- ${f.name} (${t}, optional): ${f.description}`;
  });
  return (
    `Report "${kind}" — ${spec.description}\n` +
    `Allowed parameters (all optional; omit any not implied by the request):\n` +
    lines.join('\n')
  );
}

/** Validate a candidate params object against a kind's schema. */
export function validateReportParams(
  kind: string,
  raw: unknown,
): { ok: true; params: Record<string, unknown> } | { ok: false; error: string } {
  const spec = REPORT_PARAM_SPECS[kind];
  if (!spec) return { ok: false, error: 'unknown_report_kind' };
  const r = spec.schema.safeParse(raw);
  if (!r.success) return { ok: false, error: 'invalid_params' };
  return { ok: true, params: r.data };
}

/** Best-effort extraction of the first JSON object from model text. */
export function extractJsonObject(text: string): unknown | null {
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}
