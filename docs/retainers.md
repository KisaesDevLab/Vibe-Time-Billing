# Retainers — operator guide

The retainer module lets a CPA firm sell prepaid hour packages tied to
a tax return. The client buys a retainer at the time the tax-prep
invoice ships; subsequent post-filing work (questions, amendments,
audit support) draws against those hours instead of generating new
billable WIP. Unused hours forfeit on expiry (3 years after the
original return due date).

This guide covers operator workflow. For deeper architectural notes
see `docs/retainers-architecture.md` (TBD).

## Enabling the feature

Per-firm flag, defaults OFF. To enable for the test firm:

1. Sign in as a partner.
2. Visit **Admin → Billing → Retainer tiers**.
3. In the **Firm-level retainer settings** card, tick **Feature enabled**
   and click **Save settings**.
4. Configure prep-fee work codes — typically the work codes you use
   for tax preparation. These drive the offer's prep-fee basis: only
   line items with these work codes count.

Until **Feature enabled** is true, no offers are ever auto-created,
the portal page returns 404, and dashboards are empty.

## Per-return-type tier setup

Two tiers per return type, six return types (1040, 1065, 1120, 1120S,
1041, 990). The dev seed inserts conservative defaults; tune via the
admin page.

Per tier, configure:

- **Display name** — what the client sees ("Standard Coverage" / "Premium
  Coverage" are reasonable).
- **Hours covered** — total prepaid hours.
- **Base fee** — flat amount added to every offer.
- **Pct of prep fee (basis points)** — variable amount = pct × prep-fee
  basis. 100 bps = 1%; 2500 bps = 25%.
- **Active** — uncheck to soft-disable without deleting historical
  config.
- **Eligible work codes** — which time-entry work codes will count
  against this retainer when the client buys it.

Pricing formula (D10): `base + (pct × basis) / 10000`. Banker's
rounding to whole cents. The basis is **frozen** at offer creation,
so reprice of the source invoice doesn't drift the offer.

## How an offer happens

When a biller generates an invoice from a billing batch (Admin →
Billing → Pre-bill detail → **Generate invoice**), the system checks:

1. Is the **Offer retainer to client** checkbox checked? (default ON)
2. Does the firm have `feature_enabled = true`?
3. Does the engagement have a `return_type` + `tax_year` set?
4. Is the engagement free of an existing retainer?
5. Do any of the invoice's underlying time entries use a work code in
   `prep_fee_work_code_ids`?

If all yes, a `retainer_offer` row is created with frozen tier prices
and an `offer_expires_at` = `invoice_date + offer_window_days` (60 days
default). The offer becomes visible to the client at
`/portal/retainer-offers/:id`.

If any check fails, the system silently suppresses the offer and logs
the reason — search audit logs for `entity_type='retainer_offer'` to
trace.

## Client portal flow

1. Client gets a magic-link invitation that drops them on the offer page.
2. Tier 1 (Standard) is the default; Tier 2 (Premium) is the upgrade.
3. Selecting a tier creates a new AR invoice with a single RETAINER
   line item — terms 14 days. The offer status flips to
   `pending_payment`.
4. When the client pays that invoice (Stripe webhook or the staff
   **Receive payment** flow), the system activates the retainer:
   - Inserts `retainer` row with frozen tier values
   - Computes expiry = `COALESCE(extended, original) + 3 years`
   - Snapshots eligibility (from override list or tier config)
   - Sets `engagement.retainer_id`
   - Writes ACTIVATION seed in `retainer_ledger`
5. The client sees their active retainer at `/portal/retainers`.

## Time-entry auto-split

When staff log a time entry against an engagement that has an active
retainer:

1. If the work code is in the retainer's eligible set, AND the entry
   date is on or before the retainer's expiry_date, hours draw from
   the retainer.
2. Hours that exceed the remaining balance spill into billable WIP.
3. The retainer's `hours_consumed` updates inside a SELECT FOR UPDATE
   transaction (race-safe even when two timekeepers post simultaneously).
4. A `retainer_ledger` CONSUME row is written with the delta + new
   balance.
5. When `hours_consumed = hours_purchased`, the retainer's status
   flips to `exhausted`.

The time entry itself records `retainer_id`, `retainer_hours`, and
`billable_hours` as a split breakdown. The original `hours` field is
still the canonical total — reports built on `hours` don't drift.

## Firm-initiated activation (manual)

The portal-purchase flow is optional. Partners can create a retainer
directly from **Admin → Billing → Retainers → Create retainer**:

- Pick an engagement that doesn't already have a retainer (D2 still
  applies — one per engagement)
- Pick a tier config (drives the eligibility snapshot)
- Optionally override hours, price, notes
- Save — the system inserts the retainer with `offer_id=NULL` and
  `purchase_invoice_id=NULL`, sets `engagement.retainer_id`, writes
  the ACTIVATION ledger seed row

Use cases: firm is collecting payment out-of-band (cash, check,
separate invoice), comping hours, or migrating from a legacy
prepaid-hours arrangement.

Audit logs the action with `entity_type='retainer', action='CREATE',
after.kind='manual'` so manually-created retainers are filterable.

## Pause / resume

D24 makes voiding heavy-handed — only allowed when `hours_consumed = 0`.
For everything in between, use **Pause**:

- **Pause** flips an active retainer to `status='paused'`. While paused,
  time entries against the engagement route 100% to billable WIP (the
  eligibility check returns `inactive`). The retainer's
  `hours_consumed` is preserved.
- **Resume** flips it back to `active`. If `expiry_date < today`, the
  resume also flips to `expired` instead — preventing a long-paused
  retainer from quietly re-activating beyond its expiry.

Pause/resume is firm-only (`retainer:write` — partner template).
There's no client-visible action.

## Void

D24 — voiding a retainer is allowed only when `hours_consumed = 0`.
The partner dashboard (Admin → Billing → Retainers) shows a **Void**
button on every eligible row. Voiding:

- Sets `retainer.status = 'void'` with a reason
- Clears `engagement.retainer_id` so a new offer can be issued
- Does NOT auto-issue a credit memo for the purchase invoice — operator
  handles that via the existing AR flow

## Coexistence with hour banks

Hour banks (Admin → Billing → Hour banks) are a separate prepaid-hours
concept with manual debits. **Phase 8 consumption only draws from the
retainer, never from the hour bank.** If you set up both on the same
engagement, time entries will:

1. Try the retainer first (auto-split via eligibility chain)
2. Spillover goes to billable WIP — hour banks must be debited
   manually as usual

In practice, pick one model per engagement.

## Sweeps

Two daily cron jobs run in the BullMQ worker:

- **02:00 UTC** — `retainer-expiry-sweep` flips active/exhausted
  retainers whose `expiry_date < CURRENT_DATE` to `expired`.
- **02:15 UTC** — `retainer-offer-expiry-sweep` flips pending offers
  whose `offer_expires_at < now` to `expired`. Offers in
  `pending_payment` stay alone (AR flow finishes them).

## Delayed notifications

Two delayed-only BullMQ queues fan out client-facing reminders.

### `retainer-offer-reminder`

Enqueued at offer creation (R2) with deterministic job IDs
(`retainer-offer-reminder:{offerId}:{onbill|day30|day55}`). Each
reminder fires at the kind's offset from offer creation:

- **on-bill** (~5 min after the invoice ships) — gentle nudge
- **day-30** — halfway-through reminder
- **day-55** — final reminder before the 60-day portal window closes

Each reminder is gated by a firm-settings boolean
(`notify_on_bill` / `notify_day_30` / `notify_day_55` on
`firm_retainer_settings`). Defaults to all on. The handler defensively
skips when the offer is purchased/declined/expired, the firm feature
flag is off, or no billing contact exists. Cancelled by the portal
purchase, decline, and offer-expiry-sweep paths.

### `retainer-expiry-warning`

Enqueued at activation (R3) and at firm-initiated manual activation
(R7). Four stages: 90/60/30/7 days before `expiry_date`. Job IDs are
`retainer-expiry-warning:{retainerId}:{90d|60d|30d|7d}`. The handler
skips when the retainer is paused/void/expired. The pause / void paths
cancel in-flight warnings; resume re-schedules.

Both queues require Redis. Set `REDIS_DISABLED=1` (or `NODE_ENV=test`)
to short-circuit scheduling — useful for tests and offline dev.

## Observability

The `GET /metrics` endpoint exposes five retainer gauges (Prometheus
text format) on top of the existing API metrics:

- `retainer_active_count` — currently active retainers
- `retainer_hours_remaining_total` — unconsumed hours on active retainers
- `retainer_expiring_30d` — active retainers with `expiry_date` in the
  next 30 days
- `retainer_offers_pending` — offers in `pending` status (not paid yet)
- `retainer_deferred_liability_cents` — pro-rated value of remaining
  hours across active retainers, suitable for finance dashboards

The `GET /health/retainers` endpoint returns 200 when the daily sweeps
last completed within 25h, 503 otherwise. Each sweep writes a heartbeat
into Redis (`retainer:sweep:expiry:last_run` and
`retainer:sweep:offer:last_run`) on success.

## Exports

Two staff-only CSV exports (require `retainer:read`):

- `GET /api/staff/retainers/exports/ledger.csv?retainerId=...` — full
  retainer ledger including `time_entry_id` and `created_by_id` for
  forensic drill-down. Not exposed to the portal — staff use only.
- `GET /api/staff/retainers/exports/funnel.csv?from=YYYY-MM-DD&to=YYYY-MM-DD`
  — daily offer funnel: pending / pending_payment / purchased /
  declined / expired counts per day in the window. Default window is
  the last 90 days.

One client-facing PDF:

- `GET /api/portal/retainers/:id/statement.pdf` — privacy-filtered
  Retainer Activity Statement. Rendered via the existing Puppeteer
  adapter (HTML fallback when Puppeteer isn't installed). The HTML
  builder is a pure function and is used by the staff PDF flow too.

## Open follow-ups (not in v1)

- Staff dashboard (`/my/retainers`)
- Retainer detail page with rich ledger + activity timeline
- Vibe MyBooks GL posting on activation (cash-basis per D5)

These will land as Stage R6-followup PRs.

## Locked decisions reference

See `VIBE_TB_RETAINER_ADDENDUM_BUILD_PLAN.md` §0.2 for the
authoritative D1–D24 table. The decisions that most affect operator
workflow:

- **D1**: hours overflow → auto-split to billable WIP
- **D2**: one retainer per engagement (DB-enforced)
- **D3**: expiry = `COALESCE(extended, original) + 3 years`
- **D4**: forfeit on expiry — no refund, no rollover
- **D5**: cash-basis revenue recognition at purchase
- **D12**: 60-day portal window from invoice date
- **D13**: biller toggle defaults ON
- **D22**: entry on exact `expiry_date` is eligible
- **D24**: void allowed only when `hours_consumed = 0`
