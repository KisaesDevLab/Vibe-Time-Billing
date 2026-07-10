// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Approval rule engine. Declarative rules per entity type. Used by
// adjustments, pre-bills, invoices, and engagement letters.

import type { Cents, Uuid } from '@vibe/types';
import type { AppUserRole } from '@vibe/types';

export type ApprovalEntityType = 'ADJUSTMENT' | 'PRE_BILL' | 'INVOICE' | 'ENGAGEMENT_LETTER';

export interface ApprovalContext {
  entityType: ApprovalEntityType;
  entityId: Uuid;
  /** Author / requester role; some rules exempt elevated roles. */
  requesterRole: AppUserRole;
  /** For adjustments: signed cents. */
  amountCents?: Cents;
  /** For adjustments: percent of engagement total. */
  amountPct?: number;
  /** For adjustments: reason-code label, used by rules. */
  reasonCodeLabel?: string;
  partnerInChargeId?: Uuid;
}

export type ApprovalRuleMatch = 'always' | 'never' | 'over_threshold' | 'reason_match';

export interface ApprovalRule {
  id: Uuid;
  entityType: ApprovalEntityType;
  match: ApprovalRuleMatch;
  thresholdCents?: Cents;
  thresholdPct?: number;
  reasonCodeLabels?: string[];
  /** Exempt these roles from requiring approval (e.g. partner self-approves). */
  exemptRoles?: AppUserRole[];
  /** Approver resolver — usually 'partner_in_charge'. */
  approverResolver: 'partner_in_charge' | 'firm_admin' | { fixedAppUserId: Uuid };
}

export interface ApprovalDecision {
  requiresApproval: boolean;
  rule?: ApprovalRule;
  approverAppUserId?: Uuid;
  reason?: string;
}

export function evaluate(args: {
  context: ApprovalContext;
  rules: ApprovalRule[];
}): ApprovalDecision {
  for (const rule of args.rules) {
    if (rule.entityType !== args.context.entityType) continue;
    if (rule.exemptRoles?.includes(args.context.requesterRole)) continue;

    const matched = matches(rule, args.context);
    if (!matched) continue;

    const approver = resolveApprover(rule, args.context);
    return {
      requiresApproval: true,
      rule,
      approverAppUserId: approver ?? undefined,
      reason: matched,
    };
  }
  return { requiresApproval: false };
}

function matches(rule: ApprovalRule, ctx: ApprovalContext): string | null {
  switch (rule.match) {
    case 'always':
      return 'always';
    case 'never':
      return null;
    case 'over_threshold': {
      if (rule.thresholdCents != null && ctx.amountCents != null) {
        if (Math.abs(ctx.amountCents) >= rule.thresholdCents) {
          return `amount ${ctx.amountCents} >= threshold ${rule.thresholdCents}`;
        }
      }
      if (rule.thresholdPct != null && ctx.amountPct != null) {
        if (Math.abs(ctx.amountPct) >= rule.thresholdPct) {
          return `pct ${ctx.amountPct} >= threshold ${rule.thresholdPct}`;
        }
      }
      return null;
    }
    case 'reason_match':
      if (!ctx.reasonCodeLabel || !rule.reasonCodeLabels) return null;
      return rule.reasonCodeLabels.includes(ctx.reasonCodeLabel)
        ? `reason "${ctx.reasonCodeLabel}" requires approval`
        : null;
  }
}

function resolveApprover(rule: ApprovalRule, ctx: ApprovalContext): Uuid | null {
  if (typeof rule.approverResolver === 'object') return rule.approverResolver.fixedAppUserId;
  switch (rule.approverResolver) {
    case 'partner_in_charge':
      return ctx.partnerInChargeId ?? null;
    case 'firm_admin':
      return null; // resolved out-of-band by the API
  }
}
