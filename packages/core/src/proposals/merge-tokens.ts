// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P07 — Merge-token resolver for proposal/engagement-letter
// templates (ADDENDUM-PROPOSAL-MODULE.md §P07).
//
// Resolves Mustache-style tokens `{{ scope.path }}` inside a markdown
// (or any text) body against a context object. Unknown tokens render
// as the empty string and are reported back for UI surfacing.
//
// Supported scopes (caller provides whichever are relevant):
//   client.*       — name, primary_email, mailing_address, etc.
//   firm.*         — name, address, phone, etc.
//   engagement.*   — name, start_date, end_date, fee, etc.
//   today          — ISO date in firm timezone (caller supplies)
//
// Token grammar (intentionally narrow — avoid Mustache footguns):
//   {{ scope }}              — literal scope value (today)
//   {{ scope.path }}         — nested dotted path
//   Whitespace inside the braces is tolerated.
//   No conditionals, no loops, no helpers.

export interface MergeContext {
  client?: Record<string, unknown>;
  firm?: Record<string, unknown>;
  engagement?: Record<string, unknown>;
  today?: string;
  // Free-form additional scopes for v2 (e.g. proposal.*, signer.*).
  [scope: string]: Record<string, unknown> | string | undefined;
}

export interface MergeResult {
  output: string;
  unresolvedTokens: string[];
}

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\}\}/g;

export function resolveMergeTokens(input: string, ctx: MergeContext): MergeResult {
  const unresolved: string[] = [];
  const output = input.replace(TOKEN_RE, (_match, raw: string) => {
    const value = lookup(ctx, raw);
    if (value == null) {
      unresolved.push(raw);
      return '';
    }
    return String(value);
  });
  return { output, unresolvedTokens: unresolved };
}

function lookup(ctx: MergeContext, path: string): unknown {
  const parts = path.split('.');
  const head = parts[0]!;
  if (parts.length === 1) {
    const v = ctx[head];
    // Scalar scopes (today) return their string directly. Object
    // scopes shouldn't resolve to a top-level value.
    return typeof v === 'string' ? v : null;
  }
  const scope = ctx[head];
  if (scope == null || typeof scope === 'string') return null;
  let cursor: unknown = scope;
  for (let i = 1; i < parts.length; i++) {
    if (cursor == null || typeof cursor !== 'object') return null;
    cursor = (cursor as Record<string, unknown>)[parts[i]!];
  }
  return cursor;
}

// =====================================================================
// Token catalog — kept here so the UI autocomplete can render the
// same set the resolver supports. Add to this list when binding new
// fields; the resolver itself is generic.
// =====================================================================

export interface TokenEntry {
  token: string;
  scope: 'client' | 'firm' | 'engagement' | 'meta';
  description: string;
}

export const KNOWN_TOKENS: TokenEntry[] = [
  { token: 'client.name', scope: 'client', description: "Client's legal name" },
  { token: 'client.primary_email', scope: 'client', description: "Client's primary email" },
  { token: 'client.mailing_address', scope: 'client', description: "Client's mailing address" },
  { token: 'firm.name', scope: 'firm', description: 'Firm name' },
  { token: 'firm.displayName', scope: 'firm', description: 'Firm display/brand name' },
  { token: 'firm.logo_url', scope: 'firm', description: 'Firm logo image URL' },
  { token: 'firm.address', scope: 'firm', description: 'Firm mailing address' },
  { token: 'firm.phone', scope: 'firm', description: 'Firm phone number (support)' },
  { token: 'firm.email', scope: 'firm', description: 'Firm primary email (support)' },
  { token: 'firm.fax', scope: 'firm', description: 'Firm fax number' },
  { token: 'firm.web', scope: 'firm', description: 'Firm website' },
  { token: 'firm.accent_color', scope: 'firm', description: 'Brand accent color (hex)' },
  { token: 'engagement.name', scope: 'engagement', description: 'Engagement name' },
  { token: 'engagement.start_date', scope: 'engagement', description: 'Engagement start date' },
  { token: 'engagement.end_date', scope: 'engagement', description: 'Engagement end date' },
  { token: 'engagement.tax_year', scope: 'engagement', description: 'Tax year (if applicable)' },
  { token: 'today', scope: 'meta', description: "Today's date" },
];
