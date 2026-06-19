// SPDX-License-Identifier: Elastic-2.0
import { md, type ArticleDef } from './kb-types';

export const STAFF_A_ARTICLES: ArticleDef[] = [
  {
    slug: 'dashboard-overview',
    category: 'getting-started',
    title: 'The staff Dashboard',
    summary:
      'Your home screen: firm KPIs, the Needs attention inbox, My realization, calendar, bookings, and your active engagements.',
    tags: ['dashboard', 'home', 'kpis', 'realization', 'engagements'],
    sortOrder: 60,
    body: md(`
# The staff Dashboard

The Dashboard is the app's home screen at \`/\` (the Vibe logo / left-nav home). It mixes firm-wide numbers with your personal work queue.

## Who can do this
Any signed-in staff user lands here. The firm-wide tiles read aggregate data; the personal cards (**My realization**, **My active engagements**, calendar, bookings) scope to you.

## Steps
1. Open the app — the Dashboard loads automatically at \`/\`.
2. Read the **Firm at a glance** card across the top: **Active clients**, **Active engagements**, **WIP**, **AR outstanding**, and **Collections (30d)**.
3. Triage the **Needs attention** card: click a tile to jump to that queue — **Client Msg**, **Team Msg**, **Requests**, **Intake**, or **Approvals**.
4. Check **My realization**. Toggle **Mine** vs **Service line**, then pick a date window: **MTD**, **QTD**, **YTD**, **Last 30**, or **Custom** (which reveals **From** / **To** inputs). The card title switches to **Realization by service line** in service-line mode.
5. Review **My Calendar** and the **Upcoming bookings (7 days)** card. Use **Book appointment** to create one; rows show **When** and **Subject**.
6. Work the **My active engagements** table. Filter with **Any client / Any type / Any status / Any priority**, sort the columns, and on a row use **Open** or **Time**. Use **View all →** to jump to the full Engagements list.

## Field reference
- **WIP** — unbilled work-in-process value; **AR outstanding** — open receivables.
- **My realization** columns — **Standard WIP** (original standard value), **After adjustments** (post write-up/down), **Realization** (adjusted ÷ standard).
- **My active engagements** **Due** cell shows **today**, **in Nd**, or **Nd overdue** relative to now.
- **Page size** on the engagements table offers **25 / 50 / 100** with **← Prev** / **Next →** paging.

## Common errors
The personal cards are read-only summaries, so there are no form validations here. If a tile shows zeros, you likely have no items in that scope rather than an error.

Related: [[engagements-list]], [[tasks]], [[reporting-overview]], [[report-viewer]], [[navigating-the-app]]
`),
  },
  {
    slug: 'tasks',
    category: 'engagements',
    title: 'Tasks and the client Tasks card',
    summary:
      'Track to-dos firm-wide on the Tasks page or per client, with priority, status, due dates, assignees, and auto-repeating recurrence.',
    tags: ['tasks', 'kanban', 'recurrence', 'assignee', 'todo'],
    sortOrder: 61,
    body: md(`
# Tasks

Tasks are lightweight to-dos attached to a client. Manage them firm-wide on the **Tasks** page (\`/tasks\`) or inline on a client's **Tasks** card.

## Who can do this
Viewing tasks needs **client:read**; creating, editing, completing, or removing tasks needs **client:write**. Both endpoints live under the client, so a task always belongs to one client.

## Steps
1. Open **Tasks** from the left navigation.
2. Switch the view with the **Table** / **Kanban** tabs, and the scope with **My tasks** / **All tasks**.
3. Narrow the list: type in **Search title…** and press **Search**, tick **Show done / canceled**, or pick a due window (**All due dates**, **Due this week / month / quarter / year**). **Clear filters** resets everything.
4. Click **+ New task**. In the **New task** dialog set **Client \\***, **Title \\***, optional **Description**, **Priority**, **Due date**, **Assignee**, and **Repeats**. **Status** appears only when editing an existing task.
5. Save with **Create task** (new) or **Save changes** (edit). **Cancel** discards.
6. On a Table row use **Edit**, **Done** (hidden once a task is done/canceled), or **Remove**. In **Kanban**, drag a card between status columns; empty columns read **Drop here**.

## Field reference
- **Priority** — **Low**, **Medium**, **High**, **Urgent**.
- **Status** — **Open**, **In progress**, **Blocked**, **Done**, **Canceled** (stored as OPEN / IN_PROGRESS / BLOCKED / DONE / CANCELED).
- **Repeats** — **Does not repeat**, **Weekly**, **Bi-weekly**, **Semi-monthly**, **Monthly**, **Quarterly**, **Semi-annual**, **Annual**. When a recurrence is set the dialog notes: *"When this task is completed, the next one opens automatically."* Completing the task auto-spawns the next occurrence.
- **Assignee** — clearable; blank shows **Unassigned**.

## Per-client Tasks card
On the client detail page the **Tasks** card shows an **{n} active** pill. **+ Add task** opens an inline form (**Task title \\***, **Description (optional)**, **Priority**, **Assignee…**, **Repeats** with help text *"When completed, the next task opens automatically."*). Rows offer **Done**, **Start** (while OPEN), **Edit**, and **Remove**. Empty states read **No active tasks.** / **No tasks yet.**

## Common errors
**Client** and **Title** are required (marked **\\***). The Table empty state — **No tasks** / *"Create a task or adjust the scope / filters above."* — usually means your scope or filters hid everything, not that creation failed.

Related: [[engagements-list]], [[creating-engagements]], [[dashboard-overview]], [[client-detail]]
`),
  },
  {
    slug: 'engagements-list',
    category: 'engagements',
    title: 'The Engagements list & Kanban',
    summary:
      'Browse, filter, and bulk-manage engagements across List and Board views, work-scope tabs, saved columns, and CSV export.',
    tags: ['engagements', 'kanban', 'board', 'bulk', 'csv', 'workflow'],
    sortOrder: 62,
    body: md(`
# The Engagements list

The **Engagements** workspace (\`/engagements\`) is where all engagements live. It opens in **Board** (Kanban) view by default; your choice is remembered.

## Who can do this
Staff with engagement read access see the list; bulk status/priority changes require engagement write access.

## Steps
1. Open **Engagements** from the left navigation.
2. Toggle the layout with **☰ List** and **▦ Board**.
3. Pick a work scope: **Active Work**, **All Work**, **My Work**, or **Queued Work**.
4. Tick **Show drafts** to include draft engagements.
5. In List view, open **⚙ Columns** to choose visible columns under **Show columns** (**Show all** re-enables every column).
6. Select rows, then use **Set status…** or **Set priority…** to bulk-update the selection.
7. Export the current view with **↓ CSV**.

## Field reference
- **Board** columns are your firm's workflow states — e.g. **No status**, **Not started**, **Ready**, **In progress**, **On hold**, **Needs review**, **With client**, **Completed**, **Canceled**, **Draft**.
- List columns include **Status**, **Name**, **Client**, **Type**, **Service line**, **Assignee(s)**, **Start**, **Due**, and **Priority** — each filterable and/or sortable from its header.
- **Set status…** writes the workflow state; **Set priority…** writes the priority tier across all selected engagements.

## Common errors
No form validation here — it's a browse/bulk surface. If the grid reads **No Results** / *"Please refine your filters."*, a work-scope tab or column filter is excluding everything; widen the scope or clear filters.

Related: [[creating-engagements]], [[engagement-templates]], [[recurring-engagements]], [[tasks]], [[dashboard-overview]]
`),
  },
  {
    slug: 'working-the-client-list',
    category: 'clients',
    title: 'Working the client list',
    summary:
      'Search, filter, sort, customize columns, export, bulk-email, and roll recurrences from the Clients list.',
    tags: ['clients', 'list', 'filter', 'bulk-email', 'recurrences', 'csv'],
    sortOrder: 63,
    body: md(`
# Working the client list

The **Clients** page (\`/clients\`) is the firm's roster. This article covers finding clients and acting on them in bulk; for adding records see [[creating-clients]].

## Who can do this
Staff with client read access can browse and export. **Send email** and **Roll due recurrences** are firm actions and require the matching write/admin permissions.

## Steps
1. Open **Clients** from the left navigation.
2. Search with the box: **Search name, external ID, owner, office…**.
3. Filter from the column headers — **Owner**, **Type**, **Office**, and **Status** each carry a filter; **Name**, **Outstanding Bal.**, and others sort.
4. Sort by **Outstanding Bal.** to surface clients who owe the most.
5. Adjust visible columns from the column controls, and export the list with the CSV download.
6. Select clients and click **Send email** to open **Send email to selected clients** (fill **Subject** and **Body**, then **Send to {n}**).
7. Use the header **Roll due recurrences** to advance any recurring engagements that have come due.

## Field reference
- **Outstanding Bal.** — each client's open AR balance; sortable to rank debtors.
- A status cell may read **{STATUS} · view as ↗** (opens the portal as that client) and show a **Restricted** pill where access is limited.
- The bulk-email result reports **Done.** with **{sent} sent · {skipped} skipped.**

## Common errors
The bulk-email dialog needs a **Subject** and **Body** before **Send to {n}** is meaningful. Clients without a deliverable email are counted under **skipped** rather than failing the send.

Related: [[creating-clients]], [[bulk-import-clients]], [[client-detail]], [[recurring-engagements]], [[ar-aging]]
`),
  },
  {
    slug: 'bulk-import-clients',
    category: 'clients',
    title: 'Import clients from CSV',
    summary:
      'Bulk-create clients with the Import wizard: upload a CSV, preview create/skip per row, then import.',
    tags: ['clients', 'import', 'csv', 'bulk', 'wizard'],
    sortOrder: 64,
    body: md(`
# Import clients from CSV

The **Import clients from CSV** wizard bulk-creates client records from a spreadsheet. It is a two-step flow: **1 · Upload** then **2 · Preview**.

## Who can do this
Staff with client-write access. The wizard creates new clients only — it never overwrites existing ones.

## Steps
1. From the Clients area open the import wizard (**Import clients from CSV**).
2. On **1 · Upload**, click **Download CSV template** (saves \`client-import-template.csv\`) to get the exact header row, fill it in, and choose your file under **CSV file**.
3. Optionally set **Default client owner (for rows with no owner column)** and **Default office (for rows with no office column)**.
4. Click **Preview** (shows **Validating…** while it runs). This moves you to **2 · Preview**.
5. Review the summary — **Total rows**, **Will create**, **Will skip** — and the per-row table (**Row**, **Name**, **Action** create/skip, **Reason**).
6. Click **Import {n} client(s)** (**Importing…** while it runs). On completion you'll see *"Imported {n} clients."* plus any skipped count; click **Done**. Use **Back** to return to upload.

## Field reference
- **Required column:** \`name\` — every other column is optional. Columns are matched by header name; unknown columns are ignored.
- Recognized headers include: \`name\`, \`client_owner_email\`, \`office\`, \`client_type\`, \`external_id\`, \`filing_status\`, \`pipeline_stage\`, \`terms_days\`, \`invoice_consolidation_preference\`, \`tags\`, \`mailing_street1\`, \`mailing_city\`, \`mailing_state\`, \`mailing_postal\`, \`billing_contact_name\`, \`billing_contact_email\`, \`billing_contact_phone\`.
- **Default client owner** falls back to **None**; **Default office** falls back to **Firm default office**.

## Common errors
Rows that match an existing client — by \`external_id\`, or failing that by name — are marked **skip** with a **Reason** rather than creating a duplicate. The preview must be run before **Import** is meaningful (otherwise it prompts *"Run the preview first."*).

Related: [[working-the-client-list]], [[creating-clients]], [[client-detail]]
`),
  },
  {
    slug: 'report-viewer',
    category: 'reporting',
    title: 'The detailed report viewer',
    summary:
      'Open any detailed report, set parameters, Run it, read name-resolved rows, and export CSV or PDF.',
    tags: ['reports', 'viewer', 'csv', 'pdf', 'analytics'],
    sortOrder: 65,
    body: md(`
# The report viewer

Many report-library tiles open the **report viewer** at \`/reports/view/<report>\` — a table view for one report with its own parameters and exports.

## Who can do this
Staff with reporting access. The viewer reads aggregate firm data; it has no write actions.

## Steps
1. From **Reports**, pick a report-library tile, or navigate to \`/reports/view/<kind>\`.
2. Fill any parameter inputs the report exposes — typically **Start (YYYY-MM-DD)** and **End (YYYY-MM-DD)**, or a report-specific field (see below).
3. Click **Run** to execute and populate the table.
4. Read the results — rows resolve **names, not raw IDs** (a partner, client, or engagement name instead of a long identifier).
5. Export with **⬇ CSV** or **⬇ PDF** (the PDF mirrors the on-screen, formatted table).

## Field reference — available reports
The viewer ships these report kinds:
- **Realization by partner** — write-up/down realization grouped by partner in charge.
- **Revenue by month** — billed + paid per calendar month (last 24).
- **Utilization** — billable vs total and vs available capacity (default 30 days).
- **Effective rate** — billed value ÷ billable hours per timekeeper (default 90 days).
- **Time by engagement** — hours + standard value per engagement.
- **Time by client** — hours + standard value per client.
- **Collection realization** — paid ÷ billed per partner (default 90 days).
- **Book of business** — active clients + billed/paid per partner (default 365 days).
- **Client lifetime value** — lifetime paid + billed revenue per client (top 200).
- **Firm profitability** — cost, billed, paid, and margin per engagement.
- **Capacity forecast** — projected next-4-week billable hours vs target (**Weekly target hrs**, **Start**).
- **Productivity by office** — hours + utilization per office (**Window (days)**).
- **Billable targets** — month-to-date billable hours vs the prorated monthly target (**Target override**).
- **Scope creep** — out-of-scope hours per mixed-mode engagement.
- **Approval metrics** — approval counts, rates, and response time per approver (**Window (days)**).
- **Time anomalies** — per-timekeeper daily-hours outliers by z-score (**Start**).
- **Subscription profitability** — retainer revenue vs cost-to-serve over a trailing window (**Window (days)**, **Start**).
- **Client-request capture** — billable time captured against fulfilled client requests (**Start**, **End**).

## Common errors
Dates are entered as plain **YYYY-MM-DD** text; reports with their own default window (e.g. last 90 days) still run if you leave parameters blank. If a table is empty after **Run**, the window or override likely excluded all rows.

Related: [[reporting-overview]], [[saved-reports]], [[anomaly-scope-creep]], [[dashboard-overview]]
`),
  },
  {
    slug: 'alerts-inbox',
    category: 'reporting',
    title: 'The worker-alert inbox',
    summary:
      'Review automated anomaly, scope-creep, WIP-age, and rollover alerts; open per-row details and summarize with AI.',
    tags: ['alerts', 'anomaly', 'scope-creep', 'wip', 'ai', 'audit'],
    sortOrder: 66,
    body: md(`
# The worker-alert inbox

The **Alerts** page (\`/alerts\`) collects background-worker alerts — the system's automated flags about anomalies and aging work.

## Who can do this
Gated by **admin:audit:read** (the alerts feed comes from the audit subsystem). Users without it won't see the page.

## Steps
1. Open **Alerts** from the navigation (\`/alerts\`).
2. Scan the table — **When**, **Kind**, **Subject**, **Summary**.
3. Type in **Search alerts…**, filter the **Kind** column, and sort by **When**. **Clear filters** resets active filters.
4. Click **Details** on a row to open the alert modal — it shows the kind, full timestamp, **Subject id** (truncated), and a **Full detail** JSON dump. **Close** dismisses it.
5. In the **AI summary** card, click **✨ Summarize these alerts** (it reads **Asking AI…** while working) to get a plain-language roll-up.

## Field reference — the four alert kinds
- **audit anomaly alert** — flagged anomaly from the audit trail.
- **scope creep alert** — engagement running out of scope.
- **wip age alert** — work-in-process aging past threshold.
- **engagement rollover** — a recurring engagement rolled to its next period.

Other columns: **Subject** shows a short entity reference (or "—"); **Summary** is the generated one-line description.

## Common errors
No form input means no validation. If the **✨ Summarize these alerts** button is absent, there are simply no alerts to summarize. If the whole page is unavailable, you lack **admin:audit:read**.

Related: [[anomaly-scope-creep]], [[audit-log]], [[reporting-overview]], [[report-viewer]]
`),
  },
  {
    slug: 'staff-notifications',
    category: 'messaging',
    title: 'Your in-app Notifications inbox',
    summary:
      'The staff notification center for reschedule requests, client cancellations, and calendar write failures — read, dismiss, or open.',
    tags: ['notifications', 'inbox', 'calendar', 'appointments', 'reschedule'],
    sortOrder: 67,
    body: md(`
# Your Notifications inbox

The **Notifications** page (\`/notifications\`) is your personal in-app notification center. It surfaces events that need your attention — chiefly around appointments and calendar sync.

This is **not** the same as notification *templates* (the email/SMS content engine — see [[notification-templates]]) or *staged client notifications* (the approval-gated client send pipeline — see [[staged-notifications]]). This inbox is just for you, the staff member.

## Who can do this
Any signed-in staff user has their own Notifications inbox; it shows only your notifications.

## Steps
1. Open **Notifications** (\`/notifications\`). The header shows **Notifications** with an unread count.
2. Read the **Recent (n)** list — each item shows a kind pill, a **title** (bold while unread), an optional body, and a timestamp.
3. On an item, use **Open** (jumps to the related screen, when a link exists), **Read** (marks it read — shown while unread), or **Dismiss** (always available).
4. Use **Mark all read** in the header to clear the unread count at once.

## Field reference — notification kinds
- **reschedule requested** — a client asked to reschedule an appointment.
- **appointment cancelled by client** — a client cancelled a booking.
- **provider write failed** — a calendar (M365/Google) write failed and needs attention.

Status values are UNREAD / READ / DISMISSED / ACTIONED; read/dismissed items appear dimmed.

## Common errors
There's no form to validate. When the list is empty it reads **You're all caught up.** A **provider write failed** notice usually points to a calendar connection problem — see [[connect-your-calendar]].

Related: [[notification-templates]], [[staged-notifications]], [[connect-your-calendar]], [[booking-appointments]], [[dashboard-overview]]
`),
  },
];
