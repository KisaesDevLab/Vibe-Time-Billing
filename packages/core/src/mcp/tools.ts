// SPDX-License-Identifier: Elastic-2.0
//
// MCP server tool catalog. The actual MCP wiring lives in apps/api
// (separate Express endpoint at MCP_PORT). This module defines the
// canonical tool names + their permission claims so token-issuance UI
// and audit log emit consistently.

export const MCP_TOOL_KEYS = [
  'list_engagements',
  'get_time_entries',
  'create_time_entry',
  'generate_pre_bill',
  'suggest_adjustment',
  'query_realization',
  'query_recurring_plans',
  // P5.3 — Connect addendum J.1–J.5
  'summarize_engagement_thread',
  'list_unresolved_client_requests',
  'link_message_to_time_entry',
  'suggest_billable_messages',
  'draft_pre_bill_narrative',
  // Expanded catalog — read
  'list_clients',
  'list_invoices',
  'get_ar_aging',
  // Expanded catalog — write
  'update_engagement',
  'create_client',
  // Expanded catalog — reporting
  'query_mrr',
  // Expanded catalog — automation
  'pause_recurring_plan',
  'resume_recurring_plan',
] as const;

export type McpToolKey = (typeof MCP_TOOL_KEYS)[number];

export type McpToolCategory = 'read' | 'write' | 'reporting' | 'automation' | 'connect';

// Category per tool, so the token-issuance UI can group read-only vs
// mutating/automation scopes (the latter deserve more scrutiny).
export const MCP_TOOL_CATEGORY: Record<McpToolKey, McpToolCategory> = {
  list_engagements: 'read',
  get_time_entries: 'read',
  query_realization: 'reporting',
  query_recurring_plans: 'read',
  suggest_adjustment: 'reporting',
  create_time_entry: 'write',
  generate_pre_bill: 'write',
  summarize_engagement_thread: 'connect',
  list_unresolved_client_requests: 'connect',
  link_message_to_time_entry: 'connect',
  suggest_billable_messages: 'connect',
  draft_pre_bill_narrative: 'connect',
  list_clients: 'read',
  list_invoices: 'read',
  get_ar_aging: 'reporting',
  update_engagement: 'write',
  create_client: 'write',
  query_mrr: 'reporting',
  pause_recurring_plan: 'automation',
  resume_recurring_plan: 'automation',
};

/** Tools that mutate state or trigger actions — surfaced distinctly in the UI. */
export const MCP_MUTATING_TOOLS: ReadonlySet<McpToolKey> = new Set(
  MCP_TOOL_KEYS.filter(
    (k) => MCP_TOOL_CATEGORY[k] === 'write' || MCP_TOOL_CATEGORY[k] === 'automation',
  ),
);

export interface McpTokenClaims {
  tokenId: string;
  firmId: string;
  allowedTools: McpToolKey[];
}

export function isToolAllowed(claims: McpTokenClaims, key: McpToolKey): boolean {
  return claims.allowedTools.includes(key);
}
