// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
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
] as const;

export type McpToolKey = (typeof MCP_TOOL_KEYS)[number];

export interface McpTokenClaims {
  tokenId: string;
  firmId: string;
  allowedTools: McpToolKey[];
}

export function isToolAllowed(claims: McpTokenClaims, key: McpToolKey): boolean {
  return claims.allowedTools.includes(key);
}
