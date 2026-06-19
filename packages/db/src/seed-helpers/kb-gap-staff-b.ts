// SPDX-License-Identifier: Elastic-2.0
//
// Staff-facing KB gap fill (batch B). New system articles covering the
// Engagement Letters surfaces, the Payments list / ACH returns, AR aging by
// service line, the standalone Signatures workspace, internal Team messaging,
// and the four scheduling surfaces (availability, public booking setup,
// the approval queue, and calendar review). Labels mirror the actual page
// components, not invented copy.

import { md, type ArticleDef } from './kb-types';

export const STAFF_B_ARTICLES: ArticleDef[] = [
  {
    slug: 'engagement-letters',
    category: 'engagements',
    title: 'Engagement letters',
    summary:
      'Generate a draft engagement letter from a template, send it, and track it through accept / void.',
    tags: ['engagement-letter', 'letters', 'templates', 'lifecycle'],
    sortOrder: 60,
    body: md(`
# Engagement letters

An engagement letter is the document a client signs to confirm the scope and fee of one engagement. The feature has four surfaces: the firm-wide list, a generator on the engagement, the send/accept/void lifecycle, and the admin template catalog.

This is **not** a proposal. A *proposal* is a sales document that, when accepted, auto-creates the engagement; an engagement letter is written for an engagement that already exists and never creates one. It is also distinct from *terms templates* — the engagement letter is the deliverable a client signs.

## Who can do this
- Viewing letters and the list needs \`engagement:read\`.
- Generating, sending, and voiding letters needs \`engagement:write\`.
- Editing the template catalog is an admin task.

## Steps
**Generate a draft from the engagement**
1. Open the engagement and find the **Engagement letter** card.
2. Pick a **Template** from the dropdown. The preview substitutes \`{{client.name}}\`, \`{{engagement.name}}\`, and \`{{engagement.fee}}\` (plus tax year / fiscal-year-end where present) before you save.
3. Review the preview, then click **Save as draft**. The card confirms with the new version number (e.g. "Letter v1 created as DRAFT").

**Track and manage from the list**
1. Open **Engagement letters** (\`/engagement-letters\`).
2. Use the **Status filter** to narrow to All / DRAFT / SENT / ACCEPTED / REJECTED / VOIDED.
3. Each row shows the engagement, version, status, and the Sent / Accepted / Created dates.

**Lifecycle**
- A new letter starts **DRAFT**.
- **Send** it to the client. The client reviews and e-signs it in their portal, which moves it to **ACCEPTED** (or **REJECTED** if they decline).
- **Void** a letter that should no longer stand; superseding it means generating a new version, which bumps the version number.

## Field reference
- **Template** — an ACTIVE letter template from the admin catalog; only ACTIVE templates appear in the picker. System templates are marked "system".
- **Status filter** — DRAFT (not sent), SENT (awaiting the client), ACCEPTED (client e-signed), REJECTED (client declined), VOIDED (withdrawn).
- **Version (v)** — re-generating produces a new version so the history is preserved.

## Common errors
- **No templates in the dropdown** — the catalog has no ACTIVE letter template; an admin must add/activate one.
- **Looking for proposals here** — a proposal that creates an engagement lives under Proposals, not Engagement letters. See [[proposals-overview]].
- **Variables show literally (e.g. {{engagement.fee}})** — that field is empty on the engagement (no fee set yet); it renders as "TBD" or the raw token. Set the fee, then re-generate.

Related: [[creating-engagements]] [[proposals-overview]] [[signatures-workspace]] [[notification-templates]]
`),
  },
  {
    slug: 'payments-list',
    category: 'payments',
    title: 'The Payments list — edit, re-apply, void, receipts',
    summary:
      'Manage recorded payments on the Payments tab: edit, re-apply across invoices, void, view receipts, and export CSV.',
    tags: ['payments', 'reapply', 'void', 'receipt', 'csv'],
    sortOrder: 61,
    body: md(`
# The Payments list — edit, re-apply, void, receipts

The **Payments** tab (\`/payments\`) is the payment-grain list of money received — card, ACH, in-person, and manually recorded — defaulting to the current month. This is where you correct and reconcile existing payments. To take a *new* payment, use **+ Record payment**, which opens the full Receive Payment screen; this page is for everything after.

## Who can do this
- The list and CSV export are available to staff with payments access.
- **Re-apply** and **Edit** appear only on rows you're allowed to change (manually-recorded payments); **Void** appears only where voiding is permitted. Processor-settled card/ACH payments can't be edited here — refunds happen on the invoice.

## Steps
**Find payments**
1. Set the **From** / **To** date range and optionally type a client or invoice # in **Search**, then click **Apply**. **Reset** restores the current month and clears filters.
2. The summary strip shows Payments, Gross received, Processing fees, Net, Refunds, and **In flight (ACH)**.

**Re-apply** (move/split a payment across invoices)
1. Click **Re-apply** on the row. A drawer lists the client's open invoices with an amount box each.
2. Enter amounts; the allocations must total the payment amount exactly (the drawer shows how far off you are).
3. Click **Re-apply**.

**Edit** a manually-recorded payment
1. Click **Edit**; adjust the **Amount ($)** and **Date**, then **Save changes**. (To change which invoices it covers, use Re-apply instead.)

**Void**
1. Click **Void**; optionally type a reason in the prompt and confirm. The row then shows the VOIDED pill.

**Receipt** and **CSV**
- Click **Receipt** to open a drawer listing every invoice the payment was applied to, with the total applied.
- **⤓ CSV** downloads the currently filtered rows; **Full report ↗** opens the receipt-grain Payments Received report.

## Field reference
- **In flight (ACH)** — count of payments still PENDING (an ACH debit that hasn't settled). Shown as "PROCESSING" in the Status column.
- **Channel** — derived delivery channel (card / ACH / in-person / manual).
- **Fee / Net** — processing fee withheld and what landed net.
- **Status** — SUCCEEDED, PROCESSING (PENDING), FAILED, REFUNDED, PARTIALLY_REFUNDED, or VOIDED.

## Common errors
- **Re-apply button disabled / allocations don't total** — the allocated amounts must equal the payment amount before Re-apply enables.
- **No Edit/Void on a card payment** — processor-settled payments aren't editable here; handle refunds on the invoice.

Related: [[recording-payments]] [[ach-returns]] [[credits-refunds]] [[payment-import]]
`),
  },
  {
    slug: 'ach-returns',
    category: 'payments',
    title: 'ACH returns',
    summary:
      'What an ACH return is, the NACHA classification it carries, and the action the system took automatically.',
    tags: ['ach', 'returns', 'nacha', 'mandate', 'disputes'],
    sortOrder: 62,
    body: md(`
# ACH returns

An **ACH return** is the bank's notice that an ACH debit you collected didn't clear — the client's bank pulled the money back. Common reasons are insufficient funds, a closed account, or the account holder saying they never authorized it. Late-failure *disputes* (a chargeback-style claim after settlement) also land here. Find them on the **ACH returns** tab of \`/payments\`.

## Who can do this
Staff with payments access can view the ACH returns dashboard. It is read-only — the side effects are applied automatically when the return arrives; there's nothing to approve here.

## Steps
1. Open **Payments → ACH returns**.
2. The summary shows the count of **Returns** and the total **Returned amount**.
3. Each row shows the date, client, invoice, the NACHA **Code**, the **Category**, amount, **Type** (Return vs Late dispute), and the **Action taken**.
4. Click **View** on a row to open the related invoice and collect again or follow up with the client.

## Field reference
- **Code** — the raw NACHA return code (e.g. R01, R10).
- **Category** — INSUFFICIENT FUNDS, NO AUTHORIZATION, ACCOUNT ERROR, or OTHER.
- **Action taken** —
  - **retriable** — the debit can be safely retried (typically insufficient funds).
  - **mandate voided** — the client's ACH authorization was invalidated; they must re-authorize before any further debit, and autopay on that bank account is paused automatically.
  - **bank blocked** — that payment method is blocked from future use.
  - **halted** — none of the above; the collection simply stopped.

## Common errors
- **Why was autopay paused?** — a "mandate voided" return (often a NO AUTHORIZATION code) automatically invalidates the mandate; the client must re-authorize ACH in the portal.
- **A retriable return reappears** — repeated insufficient-funds returns mean you should contact the client rather than keep retrying.

Related: [[payments-list]] [[payment-setup]] [[recording-payments]]
`),
  },
  {
    slug: 'ar-by-service-line',
    category: 'ar-collections',
    title: 'AR aging by service line',
    summary:
      'Outstanding receivables broken out by service line across the standard aging buckets.',
    tags: ['ar', 'aging', 'service-line', 'receivables', 'reporting'],
    sortOrder: 63,
    body: md(`
# AR aging by service line

This view (\`/ar/by-service-line\`) answers "which kinds of work are tying up our cash?" It pivots open receivables by **service line** across the standard aging buckets, so you can see, for example, that bookkeeping AR is current while a tax line is heavy in 90+.

## Who can do this
Staff with AR / receivables access. The view is read-only.

## Steps
1. Open **AR aging by service line** (\`/ar/by-service-line\`). The card title shows the **as-of** date the snapshot was computed.
2. Read the table: one row per service line, with a column for each aging bucket and a bold **Total**.
3. Compare buckets across rows to spot which service line is aging worst.

## Field reference
- **Service line** — the work category the receivable rolls up to.
- **0–30 / 31–60 / 61–90 / 90+** — open balance by days past due, in those buckets.
- **Total** — the row's total outstanding across all buckets.

## Common errors
- **"No outstanding AR by service line."** — nothing is currently open, or no open invoices map to a service line.
- **Numbers differ from the main AR aging** — this view groups by service line rather than by client; the firm total should still tie out. See [[ar-aging]].

Related: [[ar-aging]] [[dunning]] [[reporting-overview]]
`),
  },
  {
    slug: 'signatures-workspace',
    category: 'signatures',
    title: 'The Signatures workspace',
    summary:
      'Create an e-signature request, upload the PDF, place fields (or apply a profile), and send for signature.',
    tags: ['signatures', 'esign', 'opensign', 'fields', 'profiles'],
    sortOrder: 64,
    body: md(`
# The Signatures workspace

**Signatures** (\`/signatures\`) is the standalone workspace for firm-wide e-signature requests built on OpenSign: upload any PDF, drag signature fields onto it, and send it to one or more signers. Each request opens its own detail page (\`/signatures/:id\`) where you prepare and send it.

## Who can do this
Creating, editing, and sending requests needs \`proposal:write\` (the same permission that gates proposals). Without it you can still see the list; **+ New request** and the prepare/send actions are hidden.

## Steps
**Create a request**
1. Click **+ New request**. Enter a **Title**, pick a **Form type** (Generic document, Engagement letter, or a Form 8879 variant), and optionally a **Client** — picking one lets you check off signers from that client's people.
2. Add **Signers** (name, email, optional role); use **+ Add signer** for more. Click **Create draft**, which opens the detail page.

**Prepare & send** (on the detail page, draft only)
1. Under **Prepare & send**, click **Upload PDF** to attach the source document.
2. Either **Apply a placement profile** — choose a saved profile (matched by signer role) and click **Apply profile** — or place fields by hand in the editor: pick the **Signer** and **Field** type, then click a page to drop a field; drag to move, the corner handle to resize, the × to remove. Field types are **Signature, Initials, Date, Text, Checkbox**. Click **Save fields**.
3. Optionally **Save as profile** to reuse the current placements later (every signer with a field must have a role first).
4. Click **Send for signature**. Each signer gets their link and the request moves to *Sent*.

## Field reference
- **Form type** — labels the request; some forms route differently (see errors).
- **Field types** — Signature, Initials, Date, Text, Checkbox. Every signer needs at least one signature field.
- **Status** — Draft, Sent, Partially signed, Completed, Declined, Expired, Voided.
- **Signed (x/y)** — how many of the request's signers have completed it.

## Common errors
- **A 1040 / Form 8879 won't send remotely** — Form 8879 for an individual **1040** can't be e-signed remotely (the IRS requires Knowledge-Based Authentication, which this app doesn't offer). Use the **In-office signing** card instead. See [[in-office-signing]].
- **"Save as profile" rejected** — every signer with a placed field needs a role (profiles are keyed by role), and you must have placed at least one field.
- **Send disabled** — you can't send until at least one field is placed (and a source PDF is uploaded).

Related: [[in-office-signing]] [[opensign-signing]] [[engagement-letters]] [[collect-signatures-from-return]]
`),
  },
  {
    slug: 'team-messaging',
    category: 'messaging',
    title: 'Team messaging (internal)',
    summary:
      'Staff-only direct and group chat on the Messages → Team tab. Never visible to clients.',
    tags: ['messaging', 'team', 'internal', 'chat', 'staff'],
    sortOrder: 65,
    body: md(`
# Team messaging (internal)

The **Team** tab on **Messages** (\`/messages\`) is staff-to-staff chat — direct messages and group conversations between people at your firm. These threads are **internal and never visible to clients**, unlike the **Clients** tab, whose engagement threads are shared into the client portal.

## Who can do this
Any signed-in staff member can open the Team tab and start or join conversations. (Client-facing engagement threads on the Clients tab are a separate thing — see [[engagement-messaging]].)

## Steps
1. Open **Messages** and switch to the **Team** tab. (The tab shows an unread count, e.g. "Team (3)".)
2. The left column lists your conversations with the most recent on top; each row shows whether it's **Direct** or a **Group** (with member count) and when it was last updated.
3. Click **New** to start a conversation and pick the staff member(s).
4. Click a thread to open it on the right and type your message. Opening a thread clears its unread badge.

## Field reference
- **Direct vs Group** — a one-to-one DM versus a multi-person thread (shows "Group · N").
- **Unread badge** — the number on a thread row (and the count on the Team tab) is unread messages; it clears when you open the thread.
- **New** — starts a new direct or group conversation.

## Common errors
- **"Will the client see this?"** — no. Team threads are internal only. Use the **Clients** tab / engagement messaging for anything the client should read.
- **No conversations yet** — start one with **New**.

Related: [[engagement-messaging]] [[notification-templates]]
`),
  },
  {
    slug: 'availability-windows',
    category: 'scheduling',
    title: 'Your booking availability',
    summary:
      'Set the weekly hours you can be booked, per-window location and type limits, buffers, notice, and the booking on/off switch.',
    tags: ['scheduling', 'availability', 'booking', 'buffers', 'calendar'],
    sortOrder: 66,
    body: md(`
# Your booking availability

The **Availability** tab under **Appointments** (\`/appointments#availability\`) controls when you can be booked. Bookable slots are the **intersection** of the hours you set here with your connected calendar's free/busy — so blocking time on your calendar also removes it from booking.

## Who can do this
You edit your own availability; an admin can edit it for any staff member. The same editor appears on the admin staff profile.

## Steps
**Weekly hours**
1. Go to **Appointments → Availability**.
2. For each day, click **+ Add hours** and set the start and end **time**. Add multiple windows on one day for **split shifts** (e.g. a lunch break). Days with no window show "Unavailable".
3. Per window, optionally limit it: toggle **In-person / Phone / Video** to restrict meeting types (leave all unchecked = any), pick a default **location** from the dropdown, and toggle which appointment **Types** the window accepts (none selected = all).

**Buffers & booking rules**
4. Set **Buffer before (min)**, **Buffer after (min)**, **Minimum notice (hours)**, and **Slot increment (min)**.
5. Toggle **Enable booking on my calendar**. When off, you're hidden from the booking form's staff picker.
6. Click **Save booking settings**.

## Field reference
- **Window location toggles** — In-person / Phone / Video; empty = all allowed.
- **Window location dropdown** — a preset location applied to bookings made in that window.
- **Types** — appointment types the window accepts; empty = all types.
- **Buffer before / after** — minutes held free around each appointment (0, 5, 10, 15, 30).
- **Minimum notice (hours)** — how far ahead a slot must be (1, 2, 4, 8, 24, 48).
- **Slot increment (min)** — granularity of offered start times (15, 30, 60).
- **Enable booking on my calendar** — master on/off for being bookable.

## Common errors
- **"I have hours set but no slots show"** — your connected calendar is busy during those hours, your minimum notice rules them out, or **Enable booking on my calendar** is off.
- **Nobody can pick me in the booking form** — the booking toggle is off.

Related: [[connect-your-calendar]] [[public-booking-setup]] [[booking-appointments]] [[appointment-types]]
`),
  },
  {
    slug: 'public-booking-setup',
    category: 'scheduling',
    title: 'Setting up a public booking page',
    summary:
      'Configure the public self-booking page: slug, message, durations, buffers, notice, hold expiry, daily cap, captcha, approvers, and notifications.',
    tags: ['scheduling', 'booking-page', 'public', 'self-booking', 'setup'],
    sortOrder: 67,
    body: md(`
# Setting up a public booking page

A **public booking page** is a URL you can share so visitors request a time without logging in. Requests are *holds*, not confirmed appointments — a staff approver must confirm each one. Set pages up under **Appointments → Booking page** (\`/appointments#booking-page\`).

## Who can do this
Staff manage their own booking page from the Appointments tab. The page is for a specific staff member's calendar.

## Steps
1. Open **Appointments → Booking page** and click **New booking page** (or **Edit** an existing one). Each page row shows a copyable **Public URL** (use **Copy**).
2. **Page settings:** set an optional **Custom slug** (auto-generated if blank), choose **Allowed appointment types** (blank = all), write a **Custom message** shown on the public page, and set **Default duration (min)**, **Slot increment (min)**, **Minimum notice (hours)**, **Buffer before/after (min)**, **Hold expiry (hours)**, and an optional **Daily cap**. Toggle **Require captcha** and **Active**.
3. **Availability windows:** add weekly windows (day + start/end time) and optionally restrict **Contact types** (In-person / Phone / Video; none = any).
4. **Approvers:** pick staff who may approve/decline this page's requests. If none, the page's staff member decides.
5. **Notify on new request:** add staff and choose **EMAIL** and/or **SMS** to alert them when a request arrives.
6. Click **Create page** / **Save changes**.

## Field reference
- **Custom slug** — the tail of the public URL; must be unique.
- **Hold expiry (hours)** — how long a pending request holds its slot before lapsing (default 72).
- **Daily cap** — max requests/day for the page (blank = no cap).
- **Require captcha** — bot protection on the public form (default on).
- **Active** — whether the public URL works.
- **Approvers / Notify** — who can confirm requests, and who gets pinged about new ones.

## Common errors
- **"That custom slug is already taken."** — another page uses it; pick a different slug.
- **Visitors see no open times** — the page's windows don't overlap the staff member's calendar free/busy, or minimum notice / daily cap is blocking them.
- **No one is alerted to requests** — add staff under **Notify on new request**.

Related: [[booking-approval-queue]] [[availability-windows]] [[appointment-types]]
`),
  },
  {
    slug: 'booking-approval-queue',
    category: 'scheduling',
    title: 'Approving public booking requests',
    summary:
      'Work the Booking requests inbox: approve to create the appointment, or decline with an optional reason.',
    tags: ['scheduling', 'booking-requests', 'approve', 'decline', 'queue'],
    sortOrder: 68,
    body: md(`
# Approving public booking requests

When a visitor requests a time on a public booking page, it lands in the **Booking requests** inbox (\`/appointments#requests\`) as a pending *hold*, not a confirmed appointment. Approving it creates the appointment; declining records a reason and emails the visitor.

## Who can do this
Only an **approver** for the originating booking page (or, if a page has no approvers, that page's staff member). Acting on a request you don't approve for returns "You are not an approver for this booking page."

## Steps
1. Open **Appointments → Booking requests**. The header shows the pending count; each request is a card with the requested time, the **Staff** member, the **Visitor** (name, email, phone), any **Notes**, and when the **Hold expires**.
2. Click **Approve** to create the appointment from the request.
3. To turn it down, click **Decline**, optionally type a reason (it's emailed to the visitor), then **Confirm decline**.

## Field reference
- **Hold expires** — when the held slot lapses if no one acts; expired requests free the slot.
- **Approve** — converts the request into a real appointment on the staff member's calendar.
- **Decline** + reason — rejects the request and notifies the visitor.

## Common errors
- **"That time is no longer available — the slot was taken."** — the slot filled (or your calendar got busy) between the request and your approval; the request can't be approved.
- **"You are not an approver for this booking page."** — you're not on that page's approver list; ask an approver or an admin to add you.

Related: [[public-booking-setup]] [[availability-windows]] [[booking-appointments]]
`),
  },
  {
    slug: 'calendar-review',
    category: 'scheduling',
    title: 'Calendar review — matching unmatched events',
    summary:
      'Triage calendar events that did not auto-match a client: Confirm, Pick client, Create client, or Dismiss.',
    tags: ['scheduling', 'calendar', 'unmatched', 'review', 'matching'],
    sortOrder: 69,
    body: md(`
# Calendar review — matching unmatched events

When the app syncs your connected calendar, it tries to match each event to a client. Events it can't confidently match queue up in **Calendar review** (\`/appointments#review\`) so you can confirm or correct the match. The tab shows a badge with the number waiting.

## Who can do this
Staff who own the connected calendar (and admins) work this queue.

## Steps
1. Open **Appointments → Calendar review**. Each row shows the **Event** (subject, time, organizer) and a **Suggested client** with a confidence percentage, when the app has a guess.
2. Choose an action:
   - **Confirm** — accept the suggested client (only shown when there is one).
   - **Pick client** — search and select the correct client yourself, then it's matched.
   - **Create client** — turn the event into a new client record.
   - **Dismiss** — clear the event from the queue without matching it.

## Field reference
- **Suggested client + %** — the app's best-guess client and its confidence score (higher = more certain).
- **Confirm** — accepts that suggestion.
- **Pick client** — opens an inline search (type 2+ characters) to choose any client.
- **Create client / Dismiss** — promote to a new client, or drop the event from review.

## Common errors
- **No suggestion shown (—)** — the app couldn't guess; use **Pick client** or **Create client**.
- **Low confidence %** — treat it as a hint, not a certainty; verify before you **Confirm**.
- **"Nothing to review — all appointments are matched."** — the queue is empty.

Related: [[connect-your-calendar]] [[availability-windows]] [[booking-appointments]]
`),
  },
];
