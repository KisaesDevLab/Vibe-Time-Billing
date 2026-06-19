---
title: 'MCP server for AI agents'
slug: mcp-server
category: ai
audience: staff
tags: ['mcp', 'ai', 'agents', 'tokens', 'automation']
---

# MCP server for AI agents

The MCP (Model Context Protocol) server lets external AI agents call this firm's tools with **full read and write** access, scoped per token. Every mutating call is audit-logged with the token as the actor.

## What the MCP server exposes

The **Allowed tools** picker on **Admin → API tokens** groups the tools so you can grant least privilege:

- **Read:** `list_engagements`, `get_time_entries`, `query_recurring_plans`, `list_clients`, `list_invoices`.
- **Reporting:** `query_realization`, `suggest_adjustment` (computes a suggestion but does not write), `get_ar_aging`, `query_mrr`.
- **Write (mutating):** `create_time_entry`, `generate_pre_bill` (creates a billing batch from unbilled entries), `update_engagement`, `create_client`.
- **Automation (mutating):** `pause_recurring_plan`, `resume_recurring_plan`.
- **Connect (messaging):** `summarize_engagement_thread`, `list_unresolved_client_requests`, `link_message_to_time_entry`, `suggest_billable_messages`, `draft_pre_bill_narrative`.
- All tools are firm-scoped: cross-firm requests are rejected.

## Steps

1. Open **Admin → API tokens**.
2. In the **Create MCP token (Q13)** card, enter a **Label** (e.g. `Claude Desktop`).
3. Under **Allowed tools**, select the smallest set of tools the agent needs.
4. Click **Create token**.
5. Copy the token from the **Token (copy now — shown only once)** banner immediately — only its hash is stored.
6. Paste the token into your AI agent / MCP client configuration.
7. To list, audit, or revoke tokens later, return to this page and use the **Revoke** action.

## Fields

- **Label** — a human-readable name for the agent/integration.
- **Allowed tools** — per-tool permission scope; a call to any unselected tool is denied with `scope_denied`.
- **Status** — `ACTIVE` or `REVOKED`. Revoked or expired tokens are rejected at call time.
- **Last used** — timestamp of the token's most recent call, or `never`.

## What you'll see

- The tokens table lists each token's **Label**, tool count, **Last used**, and **Status**, with a **Revoke** button on active tokens.
- Calling a tool requires a token whose scope includes it; otherwise the call is blocked before any data is touched.
- Every tool call writes an `MCP_CALL` audit row recording the token id as actor, the tool, redacted arguments, and IP/user-agent.

## Tips

- Grant least privilege: issue separate tokens per integration rather than one all-tools token.
- Revoke immediately if a token leaks; revocation takes effect on the next call.
- Mutating tools (e.g. `create_time_entry`, `generate_pre_bill`, `update_engagement`, `create_client`, `pause_recurring_plan`, `resume_recurring_plan`, `link_message_to_time_entry`) audit every call, satisfying the firm's append-only audit guarantee.
