// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Knowledge-base articles covering admin pages that the main seed set didn't
// document yet. Staff/admin audience (audience omitted = staff/internal).
// Each body uses the real button/field/label text from the corresponding
// admin page component.
import { md, type ArticleDef } from './kb-types';

export const ADMIN_GAP_ARTICLES: ArticleDef[] = [
  {
    slug: 'webhook-keys',
    category: 'integrations',
    title: 'Inbound delivery-status webhook keys',
    summary:
      'Set the signing secret each email/SMS provider must send when it calls back with delivery status.',
    tags: ['webhooks', 'integrations', 'postmark', 'resend', 'twilio', 'textlink', 'delivery'],
    sortOrder: 60,
    body: md(`
# Inbound delivery-status webhook keys

When you send email or text through Postmark, Resend, Twilio, or TextLink, those providers call back to tell us whether each message was delivered, bounced, or failed. **Admin → Webhook keys** sets the shared secret each provider must include so we can trust those callbacks.

These are **inbound** keys — secrets *they* send *us*. They are not the same thing as the **outbound** webhooks your firm publishes to notify other systems of events here; those live under Integrations and have their own signing scheme.

## Who can do this

A firm administrator with access to Admin settings. The appliance must have **\`KMS_KEY\`** set, because the secrets are stored encrypted — without it the page shows "KMS_KEY is not set on the appliance — keys cannot be encrypted/saved" and the **Save keys** button stays disabled.

## Steps

1. Open **Admin → Webhook keys** (the "Inbound webhook signing keys" card).
2. For each provider you use — **Postmark (email)**, **Resend (email)**, **Twilio (SMS)**, or **TextLink (SMS)** — type the shared secret into its field. A provider already configured shows *(set)* and a *•••••• (saved)* placeholder.
3. Click **Save keys**. You'll see "Saved." on success.
4. In the provider's own dashboard, configure the delivery-status webhook to POST to the URL shown under each field — \`/api/webhooks/notifications/<provider>\` — and send the same secret in the **\`X-Webhook-Token\`** header.

## Field reference

- **Per-provider secret field** — the shared secret. Leave a field **blank to keep the saved value**; typing a new value replaces it. Values are stored encrypted and never shown back.
- **(set)** — shown next to a provider that already has a saved secret.
- These keys **override the appliance env vars** for the same providers.

## Common errors

- **KMS_KEY is not set** — the appliance can't encrypt secrets; set \`KMS_KEY\` and restart, then return here. **Save keys** is disabled until then.
- **Callbacks rejected / no delivery status** — the secret in the provider dashboard doesn't match what's saved here, or it isn't being sent in the \`X-Webhook-Token\` header. Re-save and re-check the provider config.
- **Wrong endpoint** — each provider has its own path; copy the exact URL shown under that provider's field.

Related: [[integrations-overview]] [[rest-api-webhooks]] [[email-not-arriving]]
`),
  },
  {
    slug: 'terminal-payments',
    category: 'payments',
    title: 'In-person card payments (Stripe Terminal)',
    summary:
      'Provision a card reader and collect chip/tap payments at the office against an invoice.',
    tags: ['payments', 'terminal', 'stripe', 'card-present', 'reader', 'in-person'],
    sortOrder: 61,
    body: md(`
# In-person card payments (Stripe Terminal)

**Admin → Terminal** lets staff take a card payment in person — at the front desk or in a meeting — by sending an amount to a physical card reader and having the client tap or insert their card. Each payment is tied to a specific invoice. The default hardware is the Stripe Reader S700 (S710 where office internet is unreliable).

## Who can do this

Staff with the **\`payment:read\`** permission can view readers and locations; **\`payment:write\`** is required to register hardware and collect payments. Stripe Connect must be set up on your firm's connected account first — the page header notes "Requires Stripe Connect to be set up."

## Steps

First-time setup (once per office):

1. In **Add a location**, fill **Display name**, **Address line 1**, **City**, **State**, **ZIP**, and click **Add location**.
2. In **Register a reader**, enter a **Reader label**, the **Registration / pairing code** from the reader's settings screen, pick the **Location**, and click **Register reader**. The reader appears in the **Readers** table with a status (online/offline).

Taking a payment:

1. In **Collect a payment in person**, pick the **Reader**, paste the **Invoice ID** (invoice uuid), enter the **Amount ($)**, and click **Send to reader**.
2. You'll see "Sent to reader — ask the client to tap or insert their card." A panel appears showing the payment and reader status.
3. Once the tap/insert succeeds, click **Capture** to take the funds. Click **Cancel** to abort before capture.

## Field reference

- **Reader** — the physical reader the request is sent to; the dropdown shows label and live status.
- **Invoice ID** — the invoice the payment is applied to.
- **Amount ($)** — dollar amount; converted to cents when sent.
- **Capture / Cancel** — finalize or abort the in-flight payment. Capture only after the client has tapped/inserted and it succeeds.
- **Readers** table — Label, Device, Serial, Status, and a **Reset** action to clear a stuck reader (cancels its current action).
- **Registration / pairing code** — comes from the reader's own settings screen when you register it.

## Common errors

- **No readers registered yet** — register a reader (and a location first) before collecting; **Send to reader** is disabled with no readers.
- **Reader stuck on a prompt** — click **Reset** in the Readers table to cancel its current action, then re-send.
- **collect_failed / capture_failed** — usually a missing Stripe Connect setup or an invalid invoice/reader. Confirm Connect is configured and the IDs are correct.
- A card saved during an in-person payment charges as **card-not-present** on later recurring runs; in-person card-present rates apply only to the live tap.

Related: [[payment-setup]] [[recording-payments]] [[users-roles]]
`),
  },
  {
    slug: 'status-history',
    category: 'admin',
    title: 'Engagement status-change history report',
    summary:
      'Firm-wide log of every engagement progress-status change — who changed it, when, and from/to.',
    tags: ['engagements', 'status', 'history', 'report', 'audit', 'admin'],
    sortOrder: 62,
    body: md(`
# Engagement status-change history report

**Admin → Status history** shows every engagement progress-status change across the whole firm in one list — who made it, when, and what it changed from and to. Use it to answer "who moved this engagement to *Filed* and when," or to audit how work flowed through your board over a period.

## Who can do this

Firm administrators with access to Admin settings. The report is read-only.

## Steps

1. Open **Admin → Status history** (the "Status change history" card).
2. Optionally set a **From** and **To** date and click **Apply** to load changes in that window.
3. Optionally type into **Filter by person** ("name contains…") to narrow to a single staff member; this filters the loaded rows live, no reload needed.

## Field reference

- **When** — the timestamp of the change, in your local time.
- **Engagement** — the engagement name (falls back to a short ID if unnamed).
- **Who** — the staff member who made the change, or **System** for automated transitions.
- **Change** — the from-status pill → the to-status pill (uses the configured labels).
- **From / To** date filters — server-side window; **Apply** reloads.
- **Filter by person** — client-side substring match on the actor name.

## Common errors

- **No rows after Apply** — there were no status changes in that date window, or the window is too narrow. Widen the dates.
- **Person filter shows nothing** — the filter is a substring of the *actor* name only; automated "System" changes won't match a person name.
- The report loads up to 1000 rows; tighten the date range if you expect more.

Related: [[engagement-status-notifications]] [[audit-log]] [[reporting-overview]]
`),
  },
  {
    slug: 'intake-settings',
    category: 'intake',
    title: 'Document intake — staff visibility & notifications',
    summary:
      'Turn the public intake page on/off and choose which staff appear, in what order, and how they are notified.',
    tags: ['intake', 'admin', 'settings', 'staff', 'notifications', 'headshot'],
    sortOrder: 63,
    body: md(`
# Document intake — staff visibility & notifications

**Admin → Intake settings** controls your public document-intake page: whether it's live at all, which staff are listed on it, the order they appear, their titles and headshots, and how each is notified when a client drops files to them. This complements the broader setup walkthrough — see [[intake-setup]] for first-time enablement.

## Who can do this

Firm administrators with access to Admin settings.

## Steps

1. Open **Admin → Document intake**.
2. Toggle **Document intake enabled (public page is live when on)** to publish or unpublish the public page.
3. In the staff table, set each person's options. Most controls save the moment you change them (the row optimistically updates); **Title** and **Order** save when you click away (on blur).
4. To set a photo, click **Upload** (or **Replace**) in the Headshot column and pick a PNG, JPEG, or WebP image.

## Field reference

- **Visible** — whether this staff member appears on the public page.
- **Accepting** — whether they're currently accepting uploads (visible but paused = listed but not taking new files).
- **Title** — display title shown to clients (e.g. "Tax Manager"); blank for none.
- **Order** — display sort order on the page (lower first).
- **Email / SMS** — whether this person is notified by email and/or text when a client uploads to them.
- **Headshot** — **Upload**/**Replace** the staff photo; accepts PNG, JPEG, WebP.
- Inactive staff rows appear dimmed.

## Common errors

- **Page not live** — the **Document intake enabled** toggle is off; turn it on.
- **A staff member missing from the public page** — their **Visible** box is unchecked (or they're inactive).
- **Upload failed** — the file isn't an accepted image type (PNG/JPEG/WebP) or the upload was rejected; try a smaller standard image.
- **No notifications on a drop-off** — that person has both **Email** and **SMS** unchecked.

Related: [[intake-setup]] [[document-requests]] [[notification-templates]]
`),
  },
  {
    slug: 'folder-templates-admin',
    category: 'files',
    title: 'Client folder templates (admin)',
    summary:
      'Define ordered starting folders shown under every client, with per-folder visibility and a firm default.',
    tags: ['files', 'folders', 'templates', 'visibility', 'admin'],
    sortOrder: 64,
    body: md(`
# Client folder templates (admin)

A folder template is a firm-level, ordered list of folders that the Files tab shows under every client's root (they stay empty until used). **Admin → Folder templates** is where you build those templates, set per-folder visibility, reorder them, and pick which one is the firm default. The default template applies to any client that hasn't been assigned a specific template.

## Who can do this

Staff with **\`firm:settings:write\`** can create, edit, reorder, and delete; without it the page is read-only.

## Steps

1. Open **Admin → Folder templates**.
2. In the left **Templates** panel, type a name and click **Add** to create a template. Use **Rename**, **Set default**, or **Delete** on each. The current default shows a **Default** pill.
3. Select a template to edit its folders on the right.
4. Add a folder: type a **Folder name**, choose a visibility in the picker, and click **Add folder**.
5. Adjust each folder's **Visibility**, toggle **Enabled**, reorder with the **↑ / ↓** buttons, or **Delete** it.

## Field reference

- **Visibility** — **Default (private)**, **Private**, or **Client-visible**. "Default" means the folder follows the system default (private) unless overridden.
- **Enabled** — whether the folder actually appears under clients; disable to retire a folder without deleting it.
- **Order** — **↑ / ↓** swap a folder with its neighbor.
- **Default** template — chosen with **Set default**; it applies to clients with no specific template.

## Common errors

- **"This is the firm default template and cannot be deleted. Set another template as default first."** — make a different template the default, then delete.
- **A folder isn't showing for clients** — it's **disabled**, or its template isn't assigned/default.
- **Clients can't see a folder you expected them to** — its visibility is **Private** (or **Default (private)**); switch it to **Client-visible**.

Related: [[files-overview]] [[sharing-and-visibility]]
`),
  },
  {
    slug: 'calendar-overview',
    category: 'scheduling',
    title: 'Admin calendar overview',
    summary:
      'See every staff member’s synced appointments, export to CSV, and check each calendar connection’s health.',
    tags: ['calendar', 'scheduling', 'admin', 'appointments', 'sync', 'csv'],
    sortOrder: 65,
    body: md(`
# Admin calendar overview

**Admin → Calendar overview** gives a firm-wide view of synced appointments across all staff, plus a health check on each staff member's calendar connection. Use it to spot appointments that didn't match to a client and to find connections that are read-only or failing to sync.

## Who can do this

Firm administrators with access to Admin settings.

## Steps

1. Open **Admin → Calendar overview**.
2. In **All-staff appointments**, filter by **Staff**, **From**, and **To**; **Clear** resets the filters.
3. Click **Export CSV** to download the currently filtered list.
4. Review **Connection health** below for each staff member's provider, last sync, and write capability.

## Field reference

All-staff appointments table:

- **When / Staff / Event / Client** — appointment time, owner, subject, and the matched client.
- **Match tier** — how confidently the appointment was matched to a client.
- **Match** — **confirmed** (success pill) vs unconfirmed (warning pill).

Connection health table:

- **Provider** — the calendar provider and connected email.
- **Status** — **OK**, **Disabled**, or a red pill showing the sync error.
- **Last synced** — timestamp of the last successful sync, or **never**.
- **Write-back** — **enabled** (we can create/update events) vs **read-only** (we can only read). A banner warns when one or more connections are read-only.

## Common errors

- **read-only connections** — appointment write-back needs the staff member to reconnect and grant calendar **write** access; the banner counts how many are affected.
- **Last synced: never / a sync error pill** — the connection failed; have that staff member reconnect their calendar.
- **No appointments** — no synced events match the current filters; widen the date range or clear the staff filter.

Related: [[scheduling]] [[integrations-overview]]
`),
  },
  {
    slug: 'signature-page-rules',
    category: 'signatures',
    title: 'Signature page detection rules',
    summary:
      'Bookmark rules that locate the signature pages inside a tax-return PDF and pick the right 8879 field layout.',
    tags: ['signatures', '8879', 'page-rules', 'bookmark', 'detection', 'admin'],
    sortOrder: 66,
    body: md(`
# Signature page detection rules

When you build a signature package from a tax-return PDF, the app finds the signature pages (e.g. the 8879) by matching the PDF's bookmarks. **Admin → Signatures → page rules** is where those rules live: each rule maps a PDF bookmark to a signature-field layout, scoped to a return type. Sensible defaults are seeded automatically, so most firms only adjust these when a new form or an unusual PDF layout shows up.

## Who can do this

Staff with **\`firm:settings:write\`** can add, edit, toggle, and delete rules; otherwise the page is read-only. Rules are grouped on screen by form type.

## Steps

1. Open the **Signature page rules** admin page.
2. To add a rule: pick the **Form type** (or **Custom…** to type one), enter a **Bookmark pattern**, choose a **Match** mode, pick the **Layout or profile** the fields come from, optionally check **Case-sensitive** / **Enabled** and add **Notes**, then click **Add rule**.
3. Edit an existing rule inline: change its **Fields from** layout in the dropdown, toggle **Enabled**, click **Edit** to change the bookmark pattern, or **Delete** to remove it.

## Field reference

- **Form type** — the return type the rule applies to (1040, 1120-S, 1065, … or **Any**).
- **bookmarkPattern** — the text matched against PDF bookmarks to locate the signature page.
- **matchMode** — **Contains**, **Exact**, or **Regex**; with **Case-sensitive** it appends "(cs)".
- **layoutKey** (shown as **Fields from**) — which signature-field layout to apply: **1040 8879 (taxpayer+spouse)**, **Entity 8879 (officer)**, **State auth (taxpayer+spouse)**, or **Generic**. You can also pick a saved **Profile: <form> (v#)** — the firm's latest placement profile for that form type, with the layout as fallback.
- **Enabled** — whether the rule participates in detection.
- **Notes** — free text for your own reference.

## Common errors

- **Signature pages not detected** — no enabled rule's bookmark pattern matched the PDF; check the bookmark text in the PDF and add/adjust a rule (try a looser **Contains** match).
- **Wrong signature fields placed** — the matched rule points at the wrong **Fields from** layout/profile; change it on the rule's row.
- **form_type_required** — you tried to add a rule with a blank custom form type.

Related: [[signatures-workspace]] [[collect-signatures-from-return]] [[tax-returns-overview]]
`),
  },
  {
    slug: 'engagement-status-notifications',
    category: 'admin',
    title: 'Engagement statuses & per-status client notifications',
    summary:
      'Manage your board statuses and configure which ones notify clients, by which channels, immediately or via approval.',
    tags: ['engagements', 'status', 'notifications', 'client', 'admin', 'messaging'],
    sortOrder: 67,
    body: md(`
# Engagement statuses & per-status client notifications

**Admin → Engagement statuses** is your firm's catalog of board (progress) statuses. Beyond color and order, each status can carry client-facing text, be scoped to specific service lines, and — the key part — automatically **notify the client** when an engagement enters it. Built-in statuses can be edited but not deleted.

## Who can do this

Firm administrators with access to Admin settings.

## Steps

1. Open **Admin → Engagement statuses**.
2. Click **+ Add status** to create a custom one, or **Edit** on any row (including built-ins) to open the editor.
3. In the editor set the **Internal label (staff)**, **Color**, and **Board order**, choose **Service lines**, and under **CLIENT PORTAL** set the **Client label** / description and whether to **Show this status to clients**.
4. Under **CLIENT NOTIFICATIONS**, check **Notify the client when an engagement enters this status**, then choose a **Delivery** mode and **Methods**.
5. Quick toggles are available right on the table: **Show clients**, **Board**.

## Field reference

- **Internal label** / **Color** / **Board order** — how staff see the status on the board.
- **Client sees / Client label** — the text clients see; blank falls back to the "standard pill".
- **Show clients** — whether the status is visible in the portal at all.
- **Service lines** — leave none selected for **All** engagements, or pick lines to scope the status to them.
- **Notifies** (the table column) — shows the configured channel pills (**email / sms / portal**) plus the mode pill (**immediate** vs **approval**).
- **Delivery** — **Require approval** (STAGED — queued under Approvals to send now, schedule, or cancel) or **Send immediately** (IMMEDIATE).
- **Methods** — **Email**, **Text message**, **Portal notice** (one or more).
- **Recipients** — **Billing contact** or **All contacts**.

## Common errors

- **Can't delete a status** — it's a **built-in**; built-ins are editable but not deletable. Delete only applies to custom statuses.
- **"Pick at least one method or nothing will be sent."** — notifications are enabled but no method is checked.
- **Notification never reaches the client** — the status isn't notify-enabled, no method is selected, or with **Require approval** the queued notice was never released under Approvals.
- **A status missing for some engagements** — it's scoped to **service lines** that don't include that engagement.

Related: [[status-history]] [[staged-notifications]] [[notification-templates]] [[approvals-overview]]
`),
  },
];
