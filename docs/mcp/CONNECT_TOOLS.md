# MCP Connect Tools

**Status:** P5.3 — five Connect-integration tools live behind the
MCP HTTP shim at `POST /api/mcp/call` with a body of
`{ "tool": "<name>", "args": { ... } }`. Token auth via
`requireApiToken`; per-tool scope enforced against `allowed_tools` on
the API token. Every call audit-logs with the token id as actor and
arguments redacted to 8-char UUID prefixes.

The MCP transport is local-only (the HTTP server runs in-appliance).
AI calls inside a tool's implementation respect
`firm_config.ai_egress_enabled` — when false, all model traffic is
routed to the local provider; when true and Vibe Shield is unreachable,
egress-requiring tools return a clean error.

---

## summarize_engagement_thread

**Permission key:** `summarize_engagement_thread`
**Egress:** local-only (decrypts server-side, returns plaintext to the
client agent over the local MCP transport)

Returns recent messages from the engagement's thread, decrypted with
the firm's MFK. The MCP client is expected to feed the result to its
own LLM to produce a summary.

```json
{
  "engagementId": "uuid",
  "since": "2026-01-01",
  "limit": 50
}
```

**Response:**

```json
{
  "threadId": "uuid",
  "messages": [
    {
      "id": "uuid",
      "createdAt": "2026-04-12T14:33:00Z",
      "senderKind": "staff" | "client",
      "body": "<plaintext>"
    }
  ]
}
```

Errors: `engagement_thread_not_found_or_cross_firm` (403/500).

---

## list_unresolved_client_requests

**Permission key:** `list_unresolved_client_requests`
**Egress:** local-only

Returns every `client_request` row in status=OPEN, optionally filtered
by engagement. Scoped to the token's firm.

```json
{ "engagementId": "uuid" } // optional
```

**Response:**

```json
{
  "items": [
    {
      "id": "uuid",
      "engagementId": "uuid",
      "title": "Send Q1 K-1",
      "body": "...",
      "assignedAppUserId": "uuid" | null,
      "dueDate": "2026-04-30" | null,
      "createdAt": "2026-04-12T14:33:00Z"
    }
  ]
}
```

---

## link_message_to_time_entry

**Permission key:** `link_message_to_time_entry`
**Mutation:** yes — writes `time_entry_message_link` rows
**Egress:** local-only

Attaches one or more messages to a time entry. Used by an MCP agent
after `suggest_billable_messages` to capture the just-suggested
billable context.

```json
{
  "timeEntryId": "uuid",
  "messageIds": ["uuid", "uuid"]
}
```

**Response:** `{ "timeEntryId": "uuid", "linkedCount": 2 }`

Errors: `time_entry_not_found_or_cross_firm` (403/500).

---

## suggest_billable_messages

**Permission key:** `suggest_billable_messages`
**Egress:** local-only

Returns every message in a period that has **not yet** been linked to a
time entry — feeds the agent the candidates to score for billability.
Anti-join via `NOT EXISTS time_entry_message_link`.

```json
{
  "engagementId": "uuid",
  "periodStart": "2026-04-01",
  "periodEnd": "2026-04-30",
  "limit": 50
}
```

**Response:** `{ threadId, candidates: [{ messageId, createdAt, senderKind, body }] }`

---

## draft_pre_bill_narrative

**Permission key:** `draft_pre_bill_narrative`
**Egress:** local-only (server returns time-entry context; agent
synthesizes the narrative)

Returns the WIP context for an invoice: every included time entry
across every billing batch on the primary engagement. The agent then
drafts the client-facing narrative.

```json
{ "invoiceId": "uuid" }
```

**Response:**

```json
{
  "invoiceId": "uuid",
  "invoiceNumber": "2026-0042",
  "totalCents": 125000,
  "timeEntries": [
    {
      "id": "uuid",
      "date": "2026-04-12",
      "hours": 2.5,
      "description": "...",
      "standardAmountCents": 75000
    }
  ]
}
```

Errors: `invoice_not_found`, `cross_firm_denied`.

---

## Token scoping

API tokens declare `allowed_tools` as an array of permission keys. The
MCP router rejects requests whose token does not list the requested
tool. To grant a token only read-only Connect access, issue it with
`allowed_tools: ["summarize_engagement_thread", "list_unresolved_client_requests", "suggest_billable_messages", "draft_pre_bill_narrative"]`.
Add `link_message_to_time_entry` only when the integration genuinely
needs write access.

## Audit log shape

Every `MCP_CALL` audit row carries:

- `actor_mcp_token_id` — the calling token
- `after.tool` — tool name
- `after.args` — UUID-redacted args (first 8 chars + ellipsis)
- `after.egressDestination` — `local-server`
- `after.piiRedacted` — true for Connect-tagged tools
