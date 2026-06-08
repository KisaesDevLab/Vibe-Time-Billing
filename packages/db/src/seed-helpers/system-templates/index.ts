// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// System template library — the shipped CPA starter content (service
// categories, services, packages, terms/engagement-letter scaffolds, and
// proposal email templates). This is static, typed data; the firm-side
// "Import defaults" flow (apps/api/src/template-library) clones selected
// entries into the firm's own editable catalog tables.
//
// Source of truth lives here (relocated from repo-root seed/templates so the
// API and @vibe/db can import it within rootDir).

export type {
  ServiceCategory,
  ServiceCategoryDefinition,
  BillingType,
  RecurringInterval,
  ServiceTemplate,
  PackageFormat,
  PackageTier,
  LineItemSection,
  PackageTemplateItem,
  PackageTemplate,
  TermsTemplateSource,
  TermsTemplate,
  EmailTemplateKind,
  EmailTemplate,
  TemplatePackManifest,
} from './types';

export { SERVICE_CATEGORIES as SERVICE_CATEGORY_DEFS } from './categories';
export { SYSTEM_SERVICE_TEMPLATES } from './services';
export { SYSTEM_PACKAGE_TEMPLATES } from './packages';
export { SYSTEM_TERMS_TEMPLATES } from './terms';
export { SYSTEM_EMAIL_TEMPLATES } from './emails';
export { SYSTEM_ENGAGEMENT_TEMPLATES } from './engagement-templates';
export type { SystemEngagementTemplate, SystemFeeStructure } from './engagement-templates';
export { SYSTEM_LETTER_TEMPLATES } from './engagement-letter-templates';
export type { SystemLetterTemplate } from './engagement-letter-templates';
export { SYSTEM_REQUEST_TEMPLATES } from './request-templates';
export type {
  SystemRequestTemplate,
  SystemRequestTemplateItem,
  SystemRequestPriority,
  SystemRequestItemKind,
} from './request-templates';
export { SYSTEM_CLIENT_TEMPLATES } from './client-templates';
export type { SystemClientTemplate, SystemClientType } from './client-templates';

/** Bump when shipped library content changes (semver). */
export const TEMPLATES_PACK_VERSION = '1.0.0';
