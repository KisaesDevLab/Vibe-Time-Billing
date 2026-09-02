// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Quick-reply template substitution for the SMS composer. Single-brace
// placeholders (the addendum's {client_first} style — distinct from the
// {{handlebars}} used by notification templates). Unknown placeholders are
// left literal and reported so the composer can warn.

export const SMS_TEMPLATE_VARS = [
  'client_first',
  'engagement_name',
  'staff_first',
  'firm',
] as const;
export type SmsTemplateVar = (typeof SMS_TEMPLATE_VARS)[number];
export type SmsTemplateVars = Partial<Record<SmsTemplateVar, string | null | undefined>>;

const PLACEHOLDER = /\{([a-z_]+)\}/g;

export function renderSmsTemplate(
  body: string,
  vars: SmsTemplateVars,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const text = body.replace(PLACEHOLDER, (match, name: string) => {
    const v = (vars as Record<string, string | null | undefined>)[name];
    if (v === undefined || v === null || v === '') {
      if (!unresolved.includes(name)) unresolved.push(name);
      return match;
    }
    return v;
  });
  return { text, unresolved };
}

/** Placeholder names present in a template body (for the variables column). */
export function extractSmsTemplateVars(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER)) {
    const name = m[1]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** First word of a full name — "Smith, John & Jane" → "John", "John Smith" → "John". */
export function firstNameOf(fullName: string | null | undefined): string {
  if (!fullName) return '';
  const trimmed = fullName.trim();
  if (!trimmed) return '';
  const comma = trimmed.indexOf(',');
  const source = comma >= 0 ? trimmed.slice(comma + 1) : trimmed;
  const first = source.trim().split(/\s+|&/)[0] ?? '';
  return first.replace(/[^\p{L}\p{N}'\-.]/gu, '');
}
