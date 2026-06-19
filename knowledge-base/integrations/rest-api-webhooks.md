---
title: 'REST API & webhooks'
slug: rest-api-webhooks
category: integrations
audience: staff
tags: ['api', 'rest', 'webhooks', 'tokens', 'integration']
---

# API access & webhooks

The appliance offers three programmatic surfaces: a token-authenticated **REST API v1** for integrators, the **MCP server** for AI agents, and **outbound webhooks** that push events to your own endpoints. The REST API and MCP share one token type and the same per-tool scoping. Inbound payment confirmation also flows through a webhook — the Stripe webhook is the source of truth that marks invoices paid.

## Steps

1. **Issue a token.** Open **Admin → AI & Integrations → API tokens**. In the **Create MCP token (Q13)** card, enter a **Label**, select the **Allowed tools**, and click **Create token**.
2. **Copy it once.** The plaintext appears in the **Token (copy now — shown only once)** banner; only its SHA-256 hash is stored. Paste it into your client.
3. **Call the REST API.** Send requests to `/api/v1/...` with header `Authorization: Bearer <token>`. Available endpoints: `GET /v1/engagements`, `GET /v1/time-entries`, `POST /v1/time-entries`, and `GET /v1/invoices`. Each route requires the matching tool scope.
4. **Or connect an AI agent.** Point an MCP client at the MCP server using the same token — see _MCP server for AI agents_.
5. **Register a webhook endpoint.** Open **Admin → Messaging → Webhooks**, enter an **HTTPS URL**, tick the **Events** you want, and click **Create**.
6. **Save the signing secret.** The **Secret (copy now — shown only once)** banner appears — store it to verify deliveries.
7. **Verify it works.** Use **Test** to fire a sample delivery, then **Deliveries** to inspect attempts. **Rotate** issues a new secret; **Archive** stops further events.

## Fields

- **Label** — name for the API/MCP token.
- **Allowed tools** — per-tool scope; a call to an unselected tool returns `403 scope_denied`.
- **HTTPS URL** — webhook receiver; must start with `https://`.
- **Events** — outbound event types: `invoice.sent`, `invoice.paid`, `invoice.overdue`, `payment.received`, `payment.failed`, `engagement.created`, `engagement.closed`, `adjustment.applied`, `pre_bill.generated`, `client.created`, `client.unlocked`, `recurring_plan.invoice_generated`.

## What you'll see

- **Inbound Stripe webhook is the source of truth.** Mounted at `/api/webhooks/stripe`, it verifies the Stripe signature against your `STRIPE_WEBHOOK_SECRET`, then on a succeeded charge marks payments **SUCCEEDED**, updates the invoice to **PARTIALLY_PAID** or **PAID**, and triggers confirmation email, deliverable unlock, and retainer activation. It's idempotent, so re-deliveries are no-ops.
- **Outbound deliveries are signed.** Each POST carries `x-vibe-event`, `x-vibe-timestamp`, `x-vibe-delivery-id`, and `x-vibe-signature` (HMAC-SHA256 over `timestamp.body` using your endpoint secret). Verify the signature on receipt.
- **Retries.** A non-2xx response is retried with exponential backoff up to 6 attempts before the delivery is marked `FAILED`. The Deliveries table shows status, attempt count, and last HTTP status.
- **REST tokens are rate-limited** to 60 requests/minute/token by default, returning `429` with `Retry-After`.

## Tips

- Grant least privilege — issue a separate token per integration and **Revoke** immediately if one leaks.
- REST mutations (e.g. `POST /v1/time-entries`) write an audit row with the **token id** as the actor, just like MCP calls.
- An unrecognized incoming Stripe charge (e.g. created from the Stripe dashboard) is skipped and surfaced in the firm's reconciliation report rather than auto-applied.
- A CPACharge webhook route exists at `/api/webhooks/cpacharge` but is a stub today.
