// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
// Shared TypeScript types for Vibe Practice Management.
//
// Exposes domain enums and primitive aliases used across api, worker, web,
// portal, and packages/core. Drizzle table row types are re-exported from
// @vibe/db; this package is for cross-cutting domain shapes only.

export type Cents = number;
export type Hours = number;
export type Uuid = string;
export type IsoDate = string;

export const AppUserRoles = ['PARTNER', 'MANAGER', 'SENIOR', 'STAFF', 'ADMIN'] as const;
export type AppUserRole = (typeof AppUserRoles)[number];

export const EntityStatuses = ['PROSPECT', 'ACTIVE', 'INACTIVE', 'CLOSED', 'ARCHIVED'] as const;
export type EntityStatus = (typeof EntityStatuses)[number];

export const FeeStructures = [
  'HOURLY',
  'HOURLY_NTE',
  'FIXED_FEE',
  'FIXED_FEE_MILESTONES',
  'RECURRING_SUBSCRIPTION',
  'MIXED_MODE',
  'HOUR_BANK',
] as const;
export type FeeStructure = (typeof FeeStructures)[number];

export const ServiceLineCategories = [
  'TAX',
  'AUDIT',
  'ADVISORY',
  'BOOKKEEPING',
  'PAYROLL',
] as const;
export type ServiceLineCategory = (typeof ServiceLineCategories)[number];

export const ReasonCodeCategories = ['WRITE_DOWN', 'WRITE_UP', 'TRANSFER'] as const;
export type ReasonCodeCategory = (typeof ReasonCodeCategories)[number];

export const AllocationMethods = [
  'SPECIFIC',
  'PRO_RATA_VALUE',
  'PRO_RATA_HOURS',
  'PARTNER_ABSORBS',
  'HIERARCHICAL_CASCADE',
  'CUSTOM_WEIGHTED',
] as const;
export type AllocationMethod = (typeof AllocationMethods)[number];

export const AdjustmentMethods = ['RATE', 'TIME', 'FEE'] as const;
export type AdjustmentMethod = (typeof AdjustmentMethods)[number];

export const PortalAccessRoles = ['FULL', 'VIEW_ONLY', 'PAY_ONLY'] as const;
export type PortalAccessRole = (typeof PortalAccessRoles)[number];

export const PortalPreferredMethods = ['EMAIL', 'SMS'] as const;
export type PortalPreferredMethod = (typeof PortalPreferredMethods)[number];

export const InvoiceConsolidationPreferences = ['CONSOLIDATED', 'SEPARATE'] as const;
export type InvoiceConsolidationPreference = (typeof InvoiceConsolidationPreferences)[number];

export const MailProviders = ['smtp', 'postmark', 'resend', 'ses'] as const;
export type MailProvider = (typeof MailProviders)[number];

export const SmsProviders = ['textlink', 'twilio', 'sns'] as const;
export type SmsProvider = (typeof SmsProviders)[number];

export const PaymentProviders = ['stripe', 'cpacharge'] as const;
export type PaymentProvider = (typeof PaymentProviders)[number];
