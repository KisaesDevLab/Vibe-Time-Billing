// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Return-type vocabulary for signature page rules. A tax return's free-text
// `formCode` (1040, 1040-SR, 1120-S, MO-1040, …) is normalized to a rule
// key so a `1040` rule matches a `1040-SR` return, while still allowing
// custom keys (states, firm-specific) and a `'*'` wildcard.

/** Common federal return types staff configure rules for. Custom keys
 *  (e.g. state codes) are still allowed — this just seeds the pickers. */
export const RETURN_TYPE_KEYS = [
  '1040',
  '1040-NR',
  '1041',
  '1065',
  '1120',
  '1120-S',
  '1120-F',
  '990',
  '990-PF',
  '990-T',
  '706',
  '709',
  '5500',
  '940',
  '941',
  '943',
  '944',
] as const;

/** Normalize a return's formCode to a rule key. Exact match wins; otherwise
 *  fold a longer code into its family (`1040-SR` → `1040`) when a base key is
 *  a prefix. Returns the upper-cased trimmed code when nothing else fits. */
export function returnTypeFamily(formCode: string | null | undefined): string {
  const code = (formCode ?? '').trim().toUpperCase();
  if (!code) return '';
  const keys = RETURN_TYPE_KEYS.map((k) => k.toUpperCase());
  if (keys.includes(code)) return code;
  // Prefer the longest base key that the code starts with (so `1120-S...`
  // folds to `1120-S` before `1120`).
  const prefix = [...keys].sort((a, b) => b.length - a.length).find((k) => code.startsWith(k));
  return prefix ?? code;
}

/** Does a rule's form_type apply to a return's formCode? `'*'` matches any. */
export function ruleAppliesToReturn(ruleFormType: string, returnFormCode: string | null): boolean {
  if (ruleFormType === '*') return true;
  const rule = ruleFormType.trim().toUpperCase();
  const family = returnTypeFamily(returnFormCode);
  return rule === family || rule === (returnFormCode ?? '').trim().toUpperCase();
}
