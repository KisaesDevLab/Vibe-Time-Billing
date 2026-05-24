# Messaging + Escrow Files Architecture

This document covers Stages 2–3 of the Connect-style feature absorption: engagement-level messaging, the Files v2 escrow zone, and client document requests. All three ship as part of TB; there is no runtime dependency on a separate Connect appliance.

## Relationship to Connect's repo

Connect's repo is a **development reference**, not a runtime dependency. The schemas, encryption pattern, and request workflow were modeled on Connect's design then re-implemented inside TB. The resulting appliance runs standalone — no `vibeconnect` Postgres schema, no shared `@vibe/notifications` package, no peer discovery.

## Messaging

### Entities

```
engagement (existing)
 │ 1:1 (auto-provisioned on create)
 ▼
thread  ◄────────────────────────────────────────────  engagement_thread_link
 │  per-thread T-DEK wrapped by firm MFK              (1:1 join row)
 │
 ├── thread_member ──── staff (app_user XOR portal_identity)
 │
 ├── message
 │    │ body_ciphertext (encrypted)
 │    │ excerpt_plaintext (first 80 chars, plaintext for list UI)
 │    │
 │    ├── message_attachment ──── files (Files v2)
 │    └── message_read_receipt ── reader (staff XOR portal)
 │
 └── time_entry_message_link ──── time_entry  (many-to-many; pre-bill citation)
```

### Lifecycle

| Event                                             | Action                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `POST /api/staff/engagements/`                    | Auto-provision a thread; mirror engagement assignments + the client's `partner_in_charge` as thread members |
| Engagement status flips to `CLOSED` or `ARCHIVED` | Thread marked `ARCHIVED`; no further messages accepted, history readable                                    |
| Engagement reopens                                | Out of scope this stage; manual member re-add via `POST /threads/:id/members`                               |
| Staff posts a message                             | Body encrypted with thread T-DEK, first 80 chars stored plaintext as `excerpt_plaintext`, audit row written |
| Portal user posts                                 | Same encryption path, `sender_portal_identity_id` populated instead                                         |
| Either party reads                                | `message_read_receipt` upserted on first GET past that message                                              |

### Why per-thread DEK

- **Forward secrecy on rotation.** Rotating one thread's key doesn't ripple to others.
- **Audit scope.** A leaked T-DEK exposes one thread's history, not the whole firm.
- **Simpler revocation.** When an engagement archives we could re-wrap the T-DEK with a stricter key in the future without touching neighbor threads.

The cost is bookkeeping: every thread row carries 28-256 bytes of wrapped-DEK overhead.

### What's plaintext

- `thread.title` (engagement name)
- `message.excerpt_plaintext` (first 80 chars of the body)
- Sender ids, timestamps, member roles

Anything more sensitive belongs in the message body.

## Files v2 escrow zone (pay-to-unlock)

We extend the existing Files v2 surface — no parallel "vault" module.

### Schema delta (`0060_files_escrow_zone.sql`)

```sql
files.visibility enum: 'private' | 'client_visible' | 'escrow'  ← added
files.invoice_id uuid REFERENCES invoice(id) ON DELETE SET NULL  ← new
files.promoted_at timestamptz                                    ← new

CHECK: visibility != 'escrow' OR invoice_id IS NOT NULL
INDEX (invoice_id) WHERE visibility='escrow' AND deleted_at IS NULL
```

### State machine

```
upload                                                  manual override
   │                                                  ◄─────────────┐
   ▼                                                                │
private  ──manual flip──►  client_visible  ─unpublish──►  private  │
   │                                ▲                              │
   │                                │ promote-on-paid              │
   ▼                                │                              │
escrow ◄────────────────────────────┘                              │
   │ (paired with invoice_id)                                      │
   │                                                               │
   │  invoice paid  ──auto──►  client_visible (promoted_at set)    │
   │                                                               │
   │  invoice refunded/voided  ──auto──►  escrow (promoted_at cleared)
   └───────────────────────────────────────────────────────────────┘
```

### Promotion paths

Both call the same `promoteEscrowFilesForInvoice(tx, {firmId, invoiceId})`:

1. **Stripe webhook** — `charge.succeeded` → `fullyPaid` branch in `apps/api/src/webhooks/stripe.ts`. After publishing `invoice.paid`, we promote.
2. **Manual receive** — `POST /api/staff/payments/receive`. `recomputeInvoicePaidReturnsFullyPaid` returns whether each touched invoice transitioned to PAID; the helper iterates and promotes.

Both paths emit `file_visibility_events` rows so the staff client-detail Files tab shows the promotion event with reason `"invoice <id> paid; auto-promote"`.

### Revert path

`charge.refunded` and `charge.dispute.created` call `revertEscrowFilesForInvoice`, which flips previously-promoted files (those with `promoted_at != NULL`) back to `escrow`. Files manually flipped to `client_visible` (no `promoted_at`) are untouched.

## Client requests

A request is a unit of work the firm owes the client (or the client owes the firm). Status flow:

```
OPEN  ──fulfill (staff or client)──►  FULFILLED
  │                                        │
  │                                        └─►  suggestion link enqueued for assigned staff
  │                                             ↓
  ├──dismiss──►  DISMISSED                      ├──accept w/ time_entry_id──►  accepted
  │                                             ├──dismiss──►  dismissed
  ├──hourly sweep, expires_at past──►  EXPIRED  └──hourly sweep, expires_at past──►  dismissed (reason='expired')
```

`expires_at` for the suggestion = `now() + firm_config.suggestion_expiration_days`. Default 7 days, firm-configurable 1–365.

### Why "suggestion" instead of auto-creating a time entry

The original Connect addendum proposed creating a time entry automatically on fulfill. We changed this to a suggestion — the staff member opens their timer, sees the suggestion, and either accepts (linking it to a new time entry they log) or dismisses. Two reasons:

1. **Capture accuracy.** Time entries need duration; the system can't guess it.
2. **Reviewable defaults.** If the suggestion expires unhandled, no garbage time entry gets created.

## Cross-realm surface

| Path                                | Realm  | Purpose                                       |
| ----------------------------------- | ------ | --------------------------------------------- |
| `/api/staff/engagement-messaging/*` | staff  | Full thread CRUD + messages                   |
| `/api/portal/messaging/*`           | portal | Scoped to active client's threads only        |
| `/api/staff/requests/*`             | staff  | Create + fulfill + dismiss + suggestion queue |
| `/api/portal/requests/*`            | portal | List + fulfill (limited; client side)         |
| `/api/staff/files/*/visibility`     | staff  | Escrow flip with `invoiceId` required         |

Cross-realm session isolation per CLAUDE.md non-negotiable #2 is unchanged — distinct cookies, signing keys, middleware.

## Audit coverage

Every mutation in this surface emits an `audit_log` row:

- `thread` create, member add, member remove
- `message` create
- `client_request` create, fulfill, dismiss, reopen
- `file_visibility_event` for every promote/revert/manual flip

Portal-side mutations carry `actor_portal_identity_id` + `active_client_id`; staff mutations carry `actor_app_user_id`.

See also: `docs/architecture/CRYPTO.md`, `docs/ops/KEY_ROTATION.md`.
