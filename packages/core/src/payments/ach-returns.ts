// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// NACHA ACH return-code classification + retry policy (Phase 21/22).
//
// Pure logic, no I/O. Two responsibilities:
//   1. classifyAchReturn(code) — is this return auto-retriable, and does it
//      invalidate the standing mandate (requires fresh authorization)?
//   2. planAchRetry(...) — given the classification + history, decide whether
//      to schedule another off-session attempt, honoring the NACHA cap of
//      at most 2 retries within 40 days of the first failure.
//
// References: NACHA return reason codes. Stripe automatically caps ACH
// retries at 2 within 40 days; we mirror that and additionally HALT (never
// auto-retry) the no-authorization codes, which require a new mandate.

/** Insufficient/uncollected funds — safe to auto-retry within the cap. */
export const ACH_RETRIABLE_CODES = ['R01', 'R09'] as const;

/**
 * "No authorization" family — STOP immediately and invalidate the mandate;
 * a new authorization is required before any further debit.
 */
export const ACH_NO_AUTH_CODES = ['R05', 'R07', 'R08', 'R10', 'R29', 'R51'] as const;

/** Account is closed/invalid/frozen — STOP; needs corrected bank details. */
export const ACH_ACCOUNT_ERROR_CODES = ['R02', 'R03', 'R04', 'R16', 'R20'] as const;

export type AchReturnCategory =
  | 'INSUFFICIENT_FUNDS'
  | 'NO_AUTHORIZATION'
  | 'ACCOUNT_ERROR'
  | 'OTHER';

export interface AchReturnClassification {
  code: string;
  category: AchReturnCategory;
  /** May be auto-retried (subject to the NACHA cap). */
  retriable: boolean;
  /** The standing mandate must be invalidated; re-authorization required. */
  invalidatesMandate: boolean;
  /** The saved bank payment method should be blocked (bad account). */
  blocksPaymentMethod: boolean;
}

/** NACHA: at most two retries within 40 days of the first failure. */
export const MAX_ACH_RETRIES = 2;
export const ACH_RETRY_WINDOW_DAYS = 40;
/** Default spacing between ACH retries (firm-configurable later). */
export const ACH_RETRY_INTERVAL_DAYS = 5;

const DAY_MS = 86_400_000;

// Stripe surfaces ACH failures as string codes (charge.failure_code /
// last_payment_error.code) rather than raw NACHA R-codes. Map the common ones
// so the classifier works regardless of which form the webhook provides.
const STRIPE_ACH_CODE_MAP: Record<string, string> = {
  insufficient_funds: 'R01',
  debit_not_authorized: 'R10',
  payment_method_not_available: 'R20',
  account_closed: 'R02',
  no_account: 'R03',
  invalid_account_number: 'R04',
  incorrect_account_holder_name: 'R03',
  account_frozen: 'R16',
  bank_account_restricted: 'R16',
  bank_account_unusable: 'R20',
  debit_disputed: 'R10',
  incorrect_account_details: 'R03',
  bank_cannot_process: 'R20',
};

/** Normalize a raw failure code (R-code or Stripe string) to a NACHA R-code. */
export function normalizeAchReturnCode(codeRaw: string | null | undefined): string {
  const raw = (codeRaw ?? '').trim();
  if (/^R\d{2}$/i.test(raw)) return raw.toUpperCase();
  return STRIPE_ACH_CODE_MAP[raw.toLowerCase()] ?? raw.toUpperCase();
}

export function classifyAchReturn(codeRaw: string | null | undefined): AchReturnClassification {
  const code = normalizeAchReturnCode(codeRaw);
  if ((ACH_RETRIABLE_CODES as readonly string[]).includes(code)) {
    return {
      code,
      category: 'INSUFFICIENT_FUNDS',
      retriable: true,
      invalidatesMandate: false,
      blocksPaymentMethod: false,
    };
  }
  if ((ACH_NO_AUTH_CODES as readonly string[]).includes(code)) {
    return {
      code,
      category: 'NO_AUTHORIZATION',
      retriable: false,
      invalidatesMandate: true,
      blocksPaymentMethod: false,
    };
  }
  if ((ACH_ACCOUNT_ERROR_CODES as readonly string[]).includes(code)) {
    return {
      code,
      category: 'ACCOUNT_ERROR',
      retriable: false,
      invalidatesMandate: true,
      blocksPaymentMethod: true,
    };
  }
  // Unknown / administrative — halt to be safe, but don't presume the mandate
  // is bad (a human reviews).
  return {
    code,
    category: 'OTHER',
    retriable: false,
    invalidatesMandate: false,
    blocksPaymentMethod: false,
  };
}

export interface AchRetryDecision {
  retry: boolean;
  /** When to make the next attempt (only when retry === true). */
  nextAt: Date | null;
  reason:
    | 'scheduled'
    | 'non_retriable'
    | 'requires_new_authorization'
    | 'max_attempts'
    | 'window_elapsed';
}

/**
 * Decide whether to schedule another ACH attempt.
 *
 * @param code           the NACHA return code from the latest failure
 * @param retriesSoFar   retries already attempted (NOT counting the original)
 * @param firstFailureAt timestamp of the first failure in this dunning run
 * @param now            current time
 */
export function planAchRetry(args: {
  code: string | null | undefined;
  retriesSoFar: number;
  firstFailureAt: Date;
  now: Date;
  intervalDays?: number;
}): AchRetryDecision {
  const cls = classifyAchReturn(args.code);
  if (!cls.retriable) {
    return {
      retry: false,
      nextAt: null,
      reason: cls.invalidatesMandate ? 'requires_new_authorization' : 'non_retriable',
    };
  }
  if (args.retriesSoFar >= MAX_ACH_RETRIES) {
    return { retry: false, nextAt: null, reason: 'max_attempts' };
  }
  const windowEnd = args.firstFailureAt.getTime() + ACH_RETRY_WINDOW_DAYS * DAY_MS;
  const interval = args.intervalDays ?? ACH_RETRY_INTERVAL_DAYS;
  const candidate = args.now.getTime() + interval * DAY_MS;
  if (candidate > windowEnd) {
    return { retry: false, nextAt: null, reason: 'window_elapsed' };
  }
  return { retry: true, nextAt: new Date(candidate), reason: 'scheduled' };
}
