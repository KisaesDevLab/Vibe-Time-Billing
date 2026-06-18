// SPDX-License-Identifier: Elastic-2.0
//
// Shared notification rendering — the one place every outbound email/SMS
// resolves its `{{ token }}` copy. Pure (no DB): callers load the firm's
// `notification_template` override (or pass null) and build the merge
// context; this resolves tokens and tidies the result.
//
// Variable insertion only (Q28): the underlying resolver supports flat
// dotted `{{ scope.path }}` tokens with no conditionals or loops. Unknown
// tokens render as the empty string, so an empty optional line collapses
// rather than printing a stray token.

import { resolveMergeTokens, type MergeContext } from '../proposals/merge-tokens';

export interface NotificationTemplate {
  /** EMAIL/PORTAL use subject+body; SMS/CALL use body only. */
  subject?: string | null;
  body: string;
}

export interface RenderedNotification {
  subject: string | null;
  body: string;
}

/** Collapse the blank-line runs an empty optional token leaves behind. */
function tidy(s: string): string {
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Render one notification. `override` is the firm's enabled
 * notification_template content (or null to use `fallback`). Both are
 * resolved against the same `context`.
 */
export function renderNotification(args: {
  override: NotificationTemplate | null;
  fallback: NotificationTemplate;
  context: MergeContext;
}): RenderedNotification {
  const tpl = args.override ?? args.fallback;
  const subjectSrc = tpl.subject ?? args.fallback.subject ?? null;
  const subject =
    subjectSrc != null ? tidy(resolveMergeTokens(subjectSrc, args.context).output) : null;
  const body = tidy(resolveMergeTokens(tpl.body, args.context).output);
  return { subject, body };
}

// Branding fields a caller can pull from firm_settings. Mirrors the
// loadEmailBranding selection plus address (no schema column today, so
// usually absent — left in so callers that do have it can pass it).
export interface FirmBrandingInput {
  name?: string | null;
  displayName?: string | null;
  logoUrl?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
  supportFax?: string | null;
  supportWeb?: string | null;
  accentColor?: string | null;
  address?: string | null;
}

/**
 * Build the `firm.*` merge scope shared by every template. Exposes the
 * firm name, logo URL and support details under BOTH naming conventions
 * the two historical resolvers used (`firm.name`/`firm.email` and
 * `firm.displayName`/`firm.supportEmail`) so existing seeded templates and
 * new ones both resolve. `displayName` falls back to the legal name.
 */
export function buildFirmScope(b: FirmBrandingInput): Record<string, string> {
  const display = b.displayName || b.name || '';
  const email = b.supportEmail ?? '';
  const phone = b.supportPhone ?? '';
  return {
    name: b.name || display,
    displayName: display,
    logo_url: b.logoUrl ?? '',
    logoUrl: b.logoUrl ?? '',
    support_email: email,
    supportEmail: email,
    email,
    support_phone: phone,
    supportPhone: phone,
    phone,
    fax: b.supportFax ?? '',
    web: b.supportWeb ?? '',
    accent_color: b.accentColor ?? '',
    address: b.address ?? '',
  };
}

/** Tokens the firm scope exposes — for the admin variable picker. */
export const FIRM_BRANDING_TOKENS: ReadonlyArray<{ token: string; description: string }> = [
  { token: 'firm.name', description: 'Firm legal name' },
  { token: 'firm.displayName', description: 'Firm display/brand name' },
  { token: 'firm.logo_url', description: 'Firm logo image URL' },
  { token: 'firm.support_email', description: 'Support email address' },
  { token: 'firm.support_phone', description: 'Support phone number' },
  { token: 'firm.fax', description: 'Support fax number' },
  { token: 'firm.web', description: 'Firm website' },
  { token: 'firm.accent_color', description: 'Brand accent color (hex)' },
];
