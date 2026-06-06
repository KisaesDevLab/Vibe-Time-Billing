// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Support knowledge base seed content. A comprehensive set of product/
// support articles shipped with the app, seeded per firm with
// is_system=true.
//
// Behavior (see seedKnowledgeBase): the shipped "system" articles are
// CODE-OWNED — on every boot/deploy they are upserted (content refreshed)
// and any system article no longer shipped is pruned. Articles authored
// by a firm admin (is_system=false, distinct slugs) are never touched.

import { and, eq, inArray, notInArray } from 'drizzle-orm';
import type { PgDatabase, QueryResultHKT } from 'drizzle-orm/pg-core';

import { kbArticles, kbCategories } from '../schema/core';

// reason: drizzle's per-schema Tx generics aren't assignment-compatible
// across call sites; widen to the base PgDatabase like the other helpers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = PgDatabase<QueryResultHKT, any, any>;

interface CategoryDef {
  slug: string;
  title: string;
  description: string;
  sortOrder: number;
}

interface ArticleDef {
  slug: string;
  category: string;
  title: string;
  summary: string;
  tags: string[];
  sortOrder: number;
  body: string;
  // 0113 — realm visibility. Omitted = 'staff' (internal). Client-facing
  // articles are tagged 'both' so they appear in the portal help center +
  // ground the portal AI support chat, and staff can still see them.
  audience?: 'staff' | 'client' | 'both';
}

export const KB_CATEGORIES: ReadonlyArray<CategoryDef> = [
  {
    // 0113 — client-facing help. Its articles are audience 'both', so this
    // is the category the portal help center + AI chat surface to clients.
    slug: 'client-help',
    title: 'Using Your Portal',
    description: 'For clients: sign in, pay invoices, upload documents, and message your firm.',
    sortOrder: 5,
  },
  {
    slug: 'getting-started',
    title: 'Getting Started',
    description: 'Sign in, navigate, and set up your account.',
    sortOrder: 10,
  },
  {
    slug: 'clients',
    title: 'Clients',
    description: 'Create and manage client records.',
    sortOrder: 20,
  },
  {
    slug: 'engagements',
    title: 'Engagements & Fees',
    description: 'Engagements, fee structures, and templates.',
    sortOrder: 30,
  },
  {
    slug: 'time-tracking',
    title: 'Time Tracking',
    description: 'Logging, editing, and reviewing time.',
    sortOrder: 40,
  },
  {
    slug: 'rates',
    title: 'Rates',
    description: 'Rate codes, overrides, and resolution.',
    sortOrder: 50,
  },
  {
    slug: 'prebill-adjustments',
    title: 'Pre-bills & Adjustments',
    description: 'WIP, billing batches, and realization allocation.',
    sortOrder: 60,
  },
  {
    slug: 'invoicing',
    title: 'Invoicing',
    description: 'Creating, sending, and managing invoices.',
    sortOrder: 70,
  },
  {
    slug: 'payments',
    title: 'Payments',
    description: 'Online and manual payments, credits, refunds.',
    sortOrder: 80,
  },
  {
    slug: 'ar-collections',
    title: 'AR & Collections',
    description: 'Aging, statements, and dunning.',
    sortOrder: 90,
  },
  {
    slug: 'client-portal',
    title: 'Client Portal',
    description: 'The branded portal your clients use.',
    sortOrder: 100,
  },
  {
    slug: 'proposals',
    title: 'Proposals',
    description: 'Services, packages, proposals, and e-signature.',
    sortOrder: 110,
  },
  {
    slug: 'tax-returns',
    title: 'Tax Returns',
    description: 'Tracking and releasing returns.',
    sortOrder: 120,
  },
  {
    slug: 'retainers',
    title: 'Retainers & Hour Banks',
    description: 'Prepaid retainers and hour banks.',
    sortOrder: 130,
  },
  {
    slug: 'files',
    title: 'Files & Requests',
    description: 'Storage, sharing, and document collection.',
    sortOrder: 140,
  },
  {
    slug: 'messaging',
    title: 'Messaging & Notifications',
    description: 'Secure messaging and notification templates.',
    sortOrder: 150,
  },
  {
    slug: 'reporting',
    title: 'Reporting & Analytics',
    description: 'Realization, utilization, profitability, and more.',
    sortOrder: 160,
  },
  {
    slug: 'approvals',
    title: 'Approvals',
    description: 'Approval rules and the approval queue.',
    sortOrder: 170,
  },
  {
    slug: 'ai',
    title: 'AI Features',
    description: 'The local-first AI assistant and tools.',
    sortOrder: 180,
  },
  {
    slug: 'admin',
    title: 'Administration',
    description: 'Firm settings, users, roles, and taxonomy.',
    sortOrder: 190,
  },
  {
    slug: 'security',
    title: 'Security',
    description: 'Authentication, encryption, and the audit trail.',
    sortOrder: 200,
  },
  {
    slug: 'deployment',
    title: 'Deployment & Operations',
    description: 'Remote access, backups, and upgrades.',
    sortOrder: 210,
  },
  {
    slug: 'integrations',
    title: 'Integrations & API',
    description: 'Payments, MCP, webhooks, and the REST API.',
    sortOrder: 220,
  },
  {
    slug: 'troubleshooting',
    title: 'Troubleshooting',
    description: 'Fixes for common issues.',
    sortOrder: 230,
  },
  {
    slug: 'scheduling',
    title: 'Scheduling & Appointments',
    description: 'Connect calendars, book appointments, manage appointment types.',
    sortOrder: 145,
  },
];

// Small helper to keep bodies readable in source.
const md = (s: string): string => s.trim();

export const KB_ARTICLES: ReadonlyArray<ArticleDef> = [
  // =================================================================== Getting Started
  {
    slug: 'welcome',
    category: 'getting-started',
    title: 'Welcome to Vibe Practice Management',
    summary: 'What the app does and how it is organized.',
    tags: ['overview', 'intro'],
    sortOrder: 10,
    body: md(`
# Welcome to Vibe Practice Management

Vibe Practice Management is the staff web app your firm uses to run client work end to end: track your time, turn it into pre-bills and invoices, apply write-ups/write-downs, and get paid. This article orients a brand-new staffer to what the app does and where things live.

## What the app is for
- **Time** tracking — log hours against clients and engagements as you work.
- Billing — review work in progress (WIP), generate billing batches and pre-bills, and apply adjustments before anything goes out.
- **Invoices** and **AR** — issue invoices and track what clients owe.
- Clients, engagements, and proposals — the records that organize all the above.
- **Help** — a built-in Knowledge Base plus an **Ask AI** assistant grounded in those articles.

## The two realms
- Staff app (this app) — where firm staff work. The header shows a \`staff\` badge.
- Client portal — a separate, branded app where clients view and pay invoices. It runs on its own subdomain (\`portal.firm.com\`) with its own login. Staff sessions never carry over to the portal and vice versa, so you sign in to each separately.

## Where to get help
- Open **Help** in the left nav for the **Knowledge Base** tab (browse or search articles) and the **Ask AI** tab (ask questions in plain language; answers cite KB articles).
- **Ask AI** only works if an administrator has enabled an AI provider; if not, the Knowledge Base still answers most questions.

## Tips
- What you can see depends on the role an admin assigns you — if a page is missing, you may not have the permission yet.
- New here? Read *Signing in*, then *Two-factor*, then the *First-week checklist*.
`),
  },
  {
    slug: 'navigating-the-app',
    category: 'getting-started',
    title: 'Navigating the app',
    summary: 'The sidebar, search, theme, and density controls.',
    tags: ['navigation', 'sidebar', 'theme', 'search'],
    sortOrder: 15,
    body: md(`
# Navigating the app

The app has a persistent left navigation (the sidebar) and a top header. This article maps every nav item so you know where to go. Items you don't have permission for, or that are role-gated, may not appear for you.

## What you'll see
The left sidebar lists, top to bottom:
- **Dashboard** — your landing page (the \`/\` home view).
- **Clients** — client records and detail pages.
- **Time** — log and review time entries.
- **Engagements** — engagement records; create and open engagements.
- **Proposals** — draft and send client proposals.
- **Billing** — billing batches and pre-bills.
- **WIP** — work-in-progress dashboard.
- **Invoices** — issued invoices and invoice detail.
- **AR** — accounts receivable.
- **Retainers** — firm-wide retainer dashboard (shows only with the \`retainer:read\` permission; otherwise you reach your own view at \`/my/retainers\`).
- **Approvals** — items awaiting your approval.
- **Requests** — document/info requests to and from clients.
- **Messages** — engagement messaging threads.
- **Reports** — realization, utilization, profitability, AR, payments-received.
- **Tax returns** — tax return tracking.
- **Alerts** — system and workflow alerts.
- **Audit** — the audit log.
- **Admin** — firm settings and administration.
- **Help** — Knowledge Base and Ask AI.
- **Account** — your profile and sign-in settings.

## Search
- Press \`Ctrl+K\` (or \`Cmd+K\` on Mac) anywhere to open Quick find.
- It searches clients, engagements, invoices, and users. Type at least 2 characters, use the arrow keys to move, and press \`Enter\` to jump to a result.

## Tips
- The header has a font-size control, a light/dark theme toggle, and a **Sign out** button.
- The active nav item is highlighted based on the page you're on.
- The sidebar can collapse; its collapsed state is remembered between visits.
`),
  },
  {
    slug: 'signing-in',
    category: 'getting-started',
    title: 'Signing in: magic link, password, or passkey',
    summary: 'Three sign-in methods and the required second factor.',
    tags: ['login', 'auth', 'sign-in', '2fa', 'password', 'magic link'],
    sortOrder: 20,
    body: md(`
# Signing in

The staff app offers three sign-in methods, shown as buttons at the top of the **Sign in** screen: **Magic link**, **Password**, and **Passkey**. Pick whichever your account is set up for.

## Steps
1. Go to the sign-in page (\`/auth/login\`). You'll see the **Sign in** heading.
2. Choose **Magic link**, **Password**, or **Passkey**.
3. Magic link: enter your **Email**, click **Send sign-in link**, then open the email and click through to complete sign-in.
4. Password: enter your **Email** and **Password**, click **Continue**, then complete the second-factor challenge (see *Two-factor*).
5. Passkey: click **Use a passkey**; your browser prompts you to pick a passkey and verify with your device's biometric or PIN. No email or password needed.

## What you'll see
- After requesting a magic link: "If your account exists, a sign-in code has been sent. Check your email." This same message appears whether or not the email matches an account — the app deliberately doesn't reveal whether an account exists (account-enumeration mitigation).
- The magic-link email opens a **Confirm sign-in** screen; click **Continue** to finish.
- Password sign-in is followed by a second-factor step unless you used a passkey as your primary method.

## Tips
- Don't have a password yet? Sign in with **Magic link**, then set one from your profile (**Account**).
- No passkey yet? Sign in by magic link or password first, then add one from **Account**.
- A wrong password shows "Email or password is incorrect." After too many attempts you may be rate-limited ("Too many attempts. Try again in a few minutes.").
`),
  },
  {
    slug: 'two-factor',
    category: 'getting-started',
    title: 'Setting up two-factor authentication',
    summary: 'Enroll a passkey, authenticator app, email code, or SMS code.',
    tags: ['2fa', 'totp', 'passkey', 'security', 'mfa'],
    sortOrder: 30,
    body: md(`
# Two-factor / second factor

Every staff user must have at least one second factor enrolled. The supported factors are passkey (WebAuthn), authenticator app (TOTP), email code, and text message (SMS). After a password or magic-link sign-in you'll be challenged for one of these; a passkey used as the primary sign-in method counts as the factor on its own.

## Steps
1. Open **Account** from the left nav.
2. Authenticator app: in **Two-factor (TOTP)** click **Generate new enrollment**, or use the enrollment screen which shows a QR code to scan, then enter the **6-digit code from your authenticator** and click **Verify & finish**.
3. Passkey: in the **Passkeys** card click **Add a passkey**, complete the browser prompt, and name it when asked.
4. Email code: in **Sign-in settings** under **Second factor**, on the **Email code** row click **Enable**.
5. Text message (SMS): on the **Text message (SMS)** row enter your number (format \`+15551234567\`), click **Send code**, then enter the texted code and click **Verify**.
6. Optionally click **Set preferred** on a factor so it's offered first at sign-in.

## What you'll see at sign-in
- If you have more than one factor, a **Choose your second factor** picker appears with buttons labeled **Authenticator app**, **Email code**, **Text message**, and **Passkey**.
- **Authenticator app**: enter the current code, then click **Sign in**.
- **Email code** / **Text message**: a code is sent automatically; the screen shows where it went, with a **Resend** button.
- **Passkey**: click **Use passkey** and confirm on your device.

## Recovery codes
- Recovery codes are generated when you enroll TOTP and are shown only once, under **Recovery codes (save now)**. Save them somewhere safe — check **I have saved these codes** before finishing.

## Tips
- Step-up re-prompt: sensitive actions re-challenge your second factor only if it's been more than 30 minutes since your last verification. **Account** shows **Step-up last verified**.
- A successful passkey verification also counts as step-up. Use **Verify a passkey now** on the **Account** page to refresh step-up on demand.
- Passkey is the strongest factor and is auto-preferred at sign-in when registered.
`),
  },
  {
    slug: 'account-profile',
    category: 'getting-started',
    title: 'Your account & profile',
    summary: 'Update your details, password, factors, and preferences.',
    tags: ['account', 'profile', 'password', 'preferences'],
    sortOrder: 40,
    body: md(`
# Your profile & account

Your personal sign-in and security settings live on the **Account** page (left nav). This is where you manage passwords, second factors, passkeys, and your active session.

## What you'll see
The **Account** page is organized into cards:
- **Identity** — shows your app user id, firm id, and **Step-up last verified** timestamp, with a **Refresh** button.
- **Two-factor (TOTP)** — **Generate new enrollment** to set up or replace your authenticator (e.g. if you lost your device); the old secret stays valid until you finish the new one.
- **Sign-in settings** — set or change your **Password** (minimum 12 characters; leave the current-password field blank if you've never set one), and manage your **Second factor** options (passkey, authenticator app, email code, text message), including **Set preferred**.
- **Passkeys** — **Add a passkey**, **Verify a passkey now**, and **Remove** existing passkeys; synced passkeys show a \`synced\` badge.
- **Sessions** — **Sign out** the current session.

## Steps to change your password
1. Open **Account**.
2. In **Sign-in settings** under **Password**, enter your current password (only if changing) and a **New password** (12+ characters).
3. Click **Save password**. You'll see "Password updated."

## Tips
- There isn't a separate display-name editor on this page; a firm administrator manages staff name and contact details in **Admin → People**. Ask an admin if your name needs to change.
- Keep at least one second factor enrolled at all times — it's required for password sign-in.
- The header (any page) also has a quick **Sign out** button plus theme and font-size controls.
`),
  },
  {
    slug: 'first-week-checklist',
    category: 'getting-started',
    title: 'First-week checklist for new staff',
    summary: 'A short path to being productive.',
    tags: ['onboarding', 'checklist', 'new'],
    sortOrder: 50,
    body: md(`
# First-week checklist

A short, practical checklist to get a new staffer productive in the staff app. Work top to bottom.

## Steps
1. Sign in for the first time using the **Magic link** option (enter your **Email**, click **Send sign-in link**, open the email, click **Continue**).
2. Enroll a second factor — you'll be prompted to set up an authenticator app (TOTP) on first sign-in, or add one from **Account**. Save your recovery codes when shown.
3. Confirm your role with an administrator. Your role (staff, senior, manager, partner, or admin) decides what you can see and do; without a role you'll hit access errors. Staff by default can read clients/engagements and create their own time entries.
4. Set a password and/or add a passkey from **Account → Sign-in settings** if you'd like an alternative to magic links.
5. Take the tour: open **Dashboard**, then click through **Clients**, **Engagements**, and **Reports** to see what your role exposes.
6. Log your first time entry: open **Time**, select a client and engagement, set the **Date** and **Hours**, fill in the **Description**, and save.
7. Learn search: press \`Ctrl+K\` (\`Cmd+K\` on Mac) to jump to any client, engagement, invoice, or user.
8. Bookmark **Help** — browse the **Knowledge Base** and try **Ask AI** for how-to questions.

## What you'll see
- On the **Time** page, the client and engagement selectors, a **Date**, an **Hours** field, an optional **Out of scope** toggle, and a **Description** box.
- A \`staff\` badge in the header confirming you're in the staff app (not the client portal).

## Tips
- If a left-nav item or button is missing, it's almost always a permission you haven't been granted — ask your admin rather than assuming it's broken.
- Time-entry hours typically round to your firm's configured increment (commonly 0.25 hour); your admin sets this.
- Re-verifying your second factor may be required for sensitive actions if more than 30 minutes have passed since your last verification.
`),
  },

  // =================================================================== Clients
  {
    slug: 'creating-clients',
    category: 'clients',
    title: 'Creating and editing clients',
    summary: 'Use the New client wizard to add an individual or business client.',
    tags: ['clients', 'create', 'individual', 'business', 'wizard'],
    sortOrder: 10,
    body: md(`
# Creating clients

## Steps
1. Open **Clients**. Click **+ New client** (top-right of the Clients card) to open the **New client** wizard.
2. **Client type** step — choose **Individual** ("Single filer, joint filer…") or **Business** ("C-corp, S-corp, LLC, partnership, sole prop, nonprofit"). This drives the next step's fields.
3. **Client info** step — fill the name (**Client name (e.g. Smith, John)** for individuals, **Business name** for businesses). Optionally tick **Use a different client-facing name**.
4. Choose **Client owner \\*** (partner in charge) and **Office \\*** (both required in the wizard).
5. Optionally set **External ID**, **Source**, **Pipeline stage** (Client / Other / Prospect), **Terms (days)** (default 30), and — for individuals — **Filing status**. Leave **Active** on (default).
6. Step through the optional **Contacts**, **Custom fields**, and **Tags** steps.
7. Finish with **Create and manage** (opens the new client) or **Create and close** (returns to the list).

## Fields
- **Client name / Business name** — required, max 200 chars. Blank shows "Name and Client owner are required."
- **Client owner** — required.
- **Office** — required in the wizard (server falls back to your default office if omitted).
- **Terms (days)** — 0–365, default 30. **Filing status** — individuals only.

## Editing later
Open the client and use **Edit** on the **Client info** card to change name, owner, office, type, filing status, pipeline, terms, invoice consolidation, the **Active** toggle, and mailing address.

## Tips
- Individual vs Business only changes the name label and whether Filing status appears — both store the same way.
`),
  },
  {
    slug: 'client-detail',
    category: 'clients',
    title: 'The client detail page',
    summary: 'The tabs and cards on a client record, and where key settings live.',
    tags: ['clients', 'detail', 'tabs', 'consolidation', 'tags'],
    sortOrder: 20,
    body: md(`
# Client detail page

Open a client from the list, or land here via **Create and manage**.

## Tabs
**Home · Messages · Requests · Communications · Notes · Files · Tasks · Engagements (count) · Billing · Tax.** Header actions: **+ Engagement**, **+ Task**, **✉ Log email**.

## Home tab cards
- **At a glance** — Engagements (active/total), WIP, Invoiced, Paid, Outstanding.
- **Client info** (**Edit**) — includes **Invoice consolidation**: **Separate invoice per engagement** or **Consolidated**; plus type, filing status, pipeline, terms, office, owner, Active toggle, mailing address.
- **Contacts**, **Portal access** (the **+ Invite to portal** entry point), **Tasks**, and **Tags + custom fields** (up to 20 tags / 30 fields — click **Save** on that card).

## Engagements tab
A recurring-engagements card, the engagements table (active rows with unbilled time show **Bill →**), and a **Merge / dedup** card.

## Tips
- Invoice consolidation defaults to **Separate**; switch to **Consolidated** to combine this client's engagements onto one invoice.
- Tags/custom fields save separately from Client info — click **Save** on their card.
`),
  },
  {
    slug: 'archiving-clients',
    category: 'clients',
    title: 'Archiving and legal holds',
    summary: 'Clients are soft-deleted (archived), never erased; legal hold blocks archival.',
    tags: ['clients', 'archive', 'legal hold', 'retention'],
    sortOrder: 30,
    body: md(`
# Archiving & legal holds

Vibe never hard-deletes a client — archiving sets its status to **ARCHIVED** and the audit log records it; engagements, invoices, and history are preserved.

## How it works today
- Find archived clients by setting the **Status** filter to **Archived** on the Clients page.
- The archive path exposed in the staff app is the **Merge / dedup** tool on a client's **Engagements** tab: choose a source client, confirm, and the source is archived after its records re-point onto the target.
- Before any archive, the client's **legal-hold** flag is checked.

## Legal hold
When legal hold is active, archiving (and merge) is **refused with a 409** (\`legal_hold_active\`) — the Merge card notes "Refuses when either client is under legal hold." Use it to preserve records for litigation or audit.

## Tips
- Because archiving is a soft-delete, it's reversible at the data level (status back to ACTIVE); nothing is erased.
- A standalone "Archive client" button / legal-hold toggle may not be present on the client cards in your build — archiving happens via the merge flow (or by an admin via the API). Confirm with your firm admin.
`),
  },

  // =================================================================== Engagements & Fees
  {
    slug: 'creating-engagements',
    category: 'engagements',
    title: 'Creating engagements',
    summary: 'Set up an engagement: client, fee structure, budget, scope, and assignees.',
    tags: ['engagements', 'create', 'scope', 'budget'],
    sortOrder: 10,
    body: md(`
# Creating engagements

## Steps
1. From the **Engagements** list click **+ New engagement** (opens \`/engagements/new\`). (From a client's time-entry link the client is pre-selected.)
2. Pick the **Client** (required).
3. Optionally pick **Start from template** — it prefills fee structure, fee, budget hours, in-scope codes, rate code, and type, and shows a **Template applied** pill. Leave on "— blank —" for an empty form.
4. Enter the engagement **Name** (a template with a name pattern shows a "Will save as:" preview).
5. Set **Fee structure** and any fee fields; optionally **Period** (Year/Month/Label), **Default rate code**, **Type** (the read-only **Service line** is derived), **Start/End/Due date**, **Partner**/**Manager**.
6. Optionally add **Additional staff** (pick a person + role, click **Add**).
7. Toggle **Mixed-mode (in-scope per entry)**, **Fee passthrough**, **Charge sales tax**, **Add invoice surcharge**, or **Recurrence** as needed.
8. Click **Create engagement** (disabled until Client and Name are set).

## Fields
- **Client** — required. **Name** — required, 1–200 chars (unless a template name pattern resolves it).
- **Fee structure** — required (default Fixed fee); a firm can disable specific structures.
- **NTE cap ($)** — appears only for Hourly NTE. **Budget hours** — optional, steps 0.25.
- **Additional staff roles** — PARTNER, MANAGER, REVIEWER, PREPARER, STAFF (up to 50).
- **In-scope work codes** — shown only when Mixed-mode is on (click chips to toggle).

## What you'll see
On success you land on the engagement detail page. If you enabled Recurrence and that step fails, you'll see "Engagement created, but recurrence setup failed… Add the recurrence from the client's Engagements tab" and still land on the engagement.

## Tips
- Recurrence requires a template (the checkbox is disabled until one is picked).
- Fee passthrough adds a processing-fee line to this engagement's invoices.
`),
  },
  {
    slug: 'fee-structures',
    category: 'engagements',
    title: 'Fee structures',
    summary: 'The five fee structures and how each one bills.',
    tags: ['fees', 'billing', 'fixed fee', 'hourly', 'subscription'],
    sortOrder: 20,
    body: md(`
# Fee structures

Every engagement has exactly one fee structure, chosen at creation (editable later). It determines how the engagement bills. The five values are:

- **HOURLY** — time-and-materials; billable time aggregates onto the invoice at each timekeeper's snapshotted rate.
- **HOURLY_NTE** — hourly with a "not to exceed" hard cap. Choosing it exposes the **NTE cap ($)** field; the cap can apply per period or for the lifetime.
- **FIXED_FEE** — a flat fee (held in **Fee amount ($)**). Time is still tracked for realization/budget, but the invoice is the fixed amount.
- **FIXED_FEE_WITH_MILESTONES** — a fixed fee split into milestones that each bill as their own invoice line when triggered (the plan must sum to the total fee).
- **RECURRING_SUBSCRIPTION** — a repeating flat fee (e.g. monthly bookkeeping/payroll); billing batches handle these via the recurring path.

## What you'll see
**Fee structure** is a dropdown of these values on the create form; **NTE cap ($)** appears only for HOURLY_NTE; **Fee amount ($)** applies to the fixed-fee structures. You can filter the Engagements list by fee structure.

## Tips
- If a structure isn't selectable, an admin has disabled it.
- Subscription "included hours" / per-employee overage are configured via template/recurring settings, not as separate fee structures.

> Note: the product is sometimes described as "seven fee structures," but the implemented set is the five above. Mixed-mode is the **Mixed-mode** toggle on a subscription engagement, and prepaid "hour bank" behavior is configured via retainers — they are options on these structures rather than separate selections.
`),
  },
  {
    slug: 'engagement-templates',
    category: 'engagements',
    title: 'Engagement templates & the starter pack',
    summary: 'Spin up a fully-configured engagement from a template; eight ship by default.',
    tags: ['templates', 'starter pack', '1040', 'audit'],
    sortOrder: 30,
    body: md(`
# Engagement templates

## Steps
1. On the New engagement form, open **Start from template** (next to Client).
2. Pick a template — only **ACTIVE** templates appear; shipped ones show a "system" tag.
3. The form prefills ("Prefilled from template. Edit any field below before creating.") with a **Template applied** pill.
4. Edit anything, fill **Client** and (if needed) **Period**, then **Create engagement**.

## What a template pre-fills
Name (if blank — a name pattern like \`Bookkeeping {{period.month}}/{{period.year}}\` resolves at create), fee structure, fee amount, budget hours, in-scope work codes, default rate code, and type.

## The shipped starter pack (8 templates)
- **Individual 1040 Tax Return** — Fixed fee, $750, 6h.
- **1120-S Tax Return** — Fixed fee w/ milestones, $3,250, 24h (50% on letter signed, 50% on filed).
- **1065 Partnership Tax Return** — Fixed fee w/ milestones, $3,500, 26h.
- **Audit Engagement (GAAS)** — Fixed fee w/ milestones, $25,000, 180h (four 25% milestones).
- **Review Engagement (SSARS)** — Fixed fee, $9,500, 60h.
- **Compilation Engagement (SSARS)** — Fixed fee, $3,500, 20h.
- **Monthly Bookkeeping** — Recurring subscription, $750/mo, 8 included hrs, mixed-mode.
- **Payroll Services** — Recurring subscription, $250/mo, 10 included employees.

## Tips
- A template is also the anchor for **recurrence** — the recurring schedule points at the template so each cycle reuses it.
- Manage templates under Admin; the picker shows only ACTIVE ones.
`),
  },
  {
    slug: 'recurring-engagements',
    category: 'engagements',
    title: 'Recurring engagements & periods',
    summary: 'Subscribe a client+template to a cadence so each period spawns automatically.',
    tags: ['recurring', 'periods', 'rollover'],
    sortOrder: 40,
    body: md(`
# Recurring engagements

## Steps
1. While creating an engagement, pick a **template**, then under **Recurrence** check **Make this engagement recurring** (disabled until a template is chosen).
2. Set: **Frequency** (Weekly / Biweekly / Monthly / Quarterly / Semiannual / Annual); **Trigger** — **On a schedule** or **When the current one closes**; **Next run date** (required for schedule); and an optional **Seed period** (year/month/label) for the first spawn.
3. Create the engagement; the recurrence is created right after.
4. Fire one manually with **Run now** on the client's **Engagements** tab (or Admin → Engagement recurrences).
5. Roll everything due at once with **Roll due recurrences** from the Clients list header.

## What you'll see
A recurrence is **ACTIVE** by default (you can pause or cancel it). A daily worker auto-spawns due recurrences. In the Roll-due dialog each row reports **spawned: {name}**, **approval queued**, **skipped**, or **error**.

## Auto-rollover collisions
If a scheduled recurrence fires while the previous period's engagement is still ACTIVE/PAUSED, it does **not** spawn — it queues an approval for the partner to decide (per the locked "notify the partner, partner decides" rule). On-completion recurrences never collide.

## Tips
- Keep period fields populated so the next period's name rolls cleanly.
- If recurrence setup failed during creation, add it later from the client's Engagements tab.
`),
  },
  {
    slug: 'milestones',
    category: 'engagements',
    title: 'Milestones',
    summary: 'Split a fixed-fee engagement into milestones that bill as they trigger.',
    tags: ['milestones', 'fixed fee', 'triggers'],
    sortOrder: 50,
    body: md(`
# Milestones

Milestones apply to **FIXED_FEE_WITH_MILESTONES** engagements; the plan's amounts must sum exactly to the engagement's total fee.

## Statuses
- **PENDING** — not yet fired (only PENDING can be triggered).
- **TRIGGERED** — fired by date/event but not yet invoiced.
- **INVOICED** — billed; carries the invoice id (shown as a success pill).
- **CANCELLED** — voided.

## How they bill
- **Manual** — in **Admin → Milestones**, pick the engagement and click **Trigger** on a PENDING row. This creates a DRAFT invoice with one **Milestone** line ("Milestone: {name}") and flips the milestone to INVOICED.
- **Date** — a daily worker marks a PENDING date milestone TRIGGERED on its date (it does not auto-invoice — a person still triggers billing).
- **Event** — an engagement status change emits an event (e.g. \`engagement.closed\`) that flips matching PENDING milestones to TRIGGERED.

## What you'll see
The engagement detail page shows a **Milestones (N)** card (#, Name, Amount, Trigger, Status). Admin → Milestones shows the engagement's **Total fee** and a **Trigger** button on PENDING rows.

## Tips
- Only triggered milestones produce revenue — date/event triggers advance status but stop short of invoicing, so billing is always a deliberate step.
- If amounts don't sum to the total fee, plan creation is rejected.
`),
  },

  // =================================================================== Time Tracking
  {
    slug: 'tracking-time',
    category: 'time-tracking',
    title: 'Logging time',
    summary: 'Log a time entry against an engagement and work code on the Time page.',
    tags: ['time', 'time entry', 'log'],
    sortOrder: 10,
    body: md(`
# Logging time

Log billable and non-billable time on the staff **Time** page (\`/time\`), which opens on the **Quick log** tab.

## Steps
1. Open **Time** from the sidebar. You're on the **Quick log** tab (other tabs: **Day**, **Week**, **Month**).
2. In the **Log time** card, pick a **Client** (active clients only; pinned clients sort to the top with a star).
3. Pick an **Engagement** — the list is filtered to that client's open engagements. If there's exactly one, it's auto-selected and shows "(auto-selected)".
4. Set the **Date** (defaults to today) and **Hours** (defaults to \`1.00\`).
5. Optionally choose a **Work code** (clearable; "— none —").
6. Type a **Description** ("What you worked on"). If AI is on, a **Describe this entry** panel offers **Suggest** / **Regenerate**.
7. Optionally tick **Out of scope** to flag the entry for review.
8. Click **Log** (shows "Saving…").

## Fields
- **Engagement** — required (\`engagementId\`). Without it: "Pick a client + engagement first."
- **Date** — required (\`entryDate\`, YYYY-MM-DD).
- **Hours** — required; positive, max \`24\`; the input steps by \`0.25\`.
- **Work code** — optional.
- **Description** — optional, up to 2000 characters.
- Your firm may set **required-field rules**; if a rule's fields are missing the save is rejected naming the rule.

## How the rate is set
The billable rate is **resolved at save** (engagement override → client override → service-line rate → your staff rate → firm default), any engagement multiplier is applied, and the resulting rate and amount are **snapshotted onto the entry** — so later rate changes never alter past entries. If no rate resolves, the save is refused.

## What you'll see
On success Hours resets to \`1.00\`, the form clears, and **My entries** reloads with the new row (Date, Client, Engagement, Hours, Amount, Flags, Description). Flags include **billable**/**non-bill**, **OOS**, and **billed** (once locked).

## Tips
- You can't log time to a PAUSED, CLOSED, ARCHIVED, or retainer-locked engagement.
- Back-dated entries older than the firm's late-entry lockout window are refused.
`),
  },
  {
    slug: 'time-grids-and-targets',
    category: 'time-tracking',
    title: 'Day, week & month views and targets',
    summary: 'Review your hours by period with color-coded target indicators.',
    tags: ['time', 'day', 'week', 'month', 'utilization'],
    sortOrder: 20,
    body: md(`
# Day, week & month views

The **Time** page has four tabs: **Quick log**, **Day**, **Week**, **Month**. The last three summarize your own logged hours.

## Steps
1. Open **Time** and click **Day**, **Week**, or **Month**.
2. **Day** — use **‹** / **›** or the date field; entries are grouped by engagement with billable/OOS pills.
3. **Week** — use **‹ Prev**, **Next ›**, or **This week**; a Monday-anchored grid shows one row per engagement, a **Total** column, and a **Daily total** row.
4. **Month** — review the 62-day **Recent activity** heatmap and the **Month rollup** table (Month · Hours · Standard $ · Entries); the selector switches Last 3 / 6 / 12 / 24 months.

## What you'll see (target colors)
- **Day** pill, e.g. "8.00h (6.50 billable)": green ≥7h, amber ≥4h, red below.
- **Week** pill: green ≥35h, amber ≥20h, else red.
- The heatmap shades each day by hours (amber below 7h, green at/above).

These thresholds are **display indicators**, not enforced limits. Out-of-scope work shows an **OOS** pill; non-billable shows a **non-bill** pill.

## Tips
- The **Quick log → My entries** list supports filters (client, engagement, dates, billable, out-of-scope), sorting, and paging (50/100/200).
`),
  },
  {
    slug: 'editing-time',
    category: 'time-tracking',
    title: 'Editing, deleting, and locking time',
    summary: 'Correct your own entries; understand versioning, locking, and the late-entry window.',
    tags: ['time', 'edit', 'delete', 'lockout'],
    sortOrder: 30,
    body: md(`
# Editing & locking time

Edit or delete your **own** entries from **My entries** until they're locked or billed.

## Steps
1. On **Time → Quick log**, find the row in **My entries**.
2. Click **Edit** — Hours, Description, and the **billable** / **OOS** checkboxes become inline-editable (editing one row disables Edit on others).
3. Adjust fields (Hours must be positive, ≤ 24) and click **Save** ("Saving…") or **Cancel**.
4. To remove an entry, click **Delete** and confirm "Delete this time entry?" — this soft-deletes (archives) it.

## What changes
- Editable: Hours, Description, Work code, billable flag, out-of-scope override.
- The **rate snapshot does not change** on edit; when hours change the amount is recomputed as the original rate × new hours.
- Every edit and delete is **version-stamped** (prior values kept) for audit — nothing is truly erased.

## When you can't edit
- Only **your own** entries (others return "forbidden").
- An entry becomes **read-only once locked or attached to a billing batch** — **Edit**/**Delete** disappear and the row shows a **billed** pill.

## Late-entry lockout
When creating an entry, the firm's late-entry window applies (default **14 days**, configurable). Entries dated before the cutoff are refused as "late entry locked." Set 0 to disable.

## Tips
- Logged to the wrong engagement? Moving an entry between engagements is a manager/partner action, not a self-service edit.
`),
  },

  // =================================================================== Rates
  {
    slug: 'rate-basics',
    category: 'rates',
    title: 'Rate codes and standard rates',
    summary: 'How billable rates are defined.',
    tags: ['rates', 'rate code', 'standard rate'],
    sortOrder: 10,
    body: md(`
# Billing rates basics

Every billable time entry needs an hourly billing rate. This article explains where rates come from, how the app picks the right one for a time entry, and why the rate is locked in the moment the entry is saved. Rate setup lives in the admin area under **Rate codes**, **Rates**, and each staff member's detail page.

## Steps
1. Open the admin area and click **Rate codes** (\`/admin/rate-codes\`).
2. Review the rate-code catalog. Every firm has a system-seeded \`StandardRate\` code (shown with a \`system\` pill); it is the resolver fallback and cannot be renamed, deactivated, or deleted.
3. To add a code, fill **Code**, **Description**, and **Sort**, then click **Add**. Codes edit inline and save with **Save**.
4. To set a staff member's rates, go to **Users**, open a person, and select the **Rates** tab.
5. Under **Effective-dated billing rates**, click **+ New effective period**.
6. Enter an **Effective date** and **Cost / hr ($)**, then a **$ / hr** billing rate for each rate code. \`StandardRate\` is required on every snapshot.
7. Click **Save snapshot**. Snapshots are append-only — to change a rate later, add another effective period; you never edit a saved one.
8. To check what a time entry will bill at, open **Rates** (\`/admin/rates\`) and use the **Resolve-debug — why is this rate $X** panel.

## Fields
- **Code** — the rate code name (e.g. \`StandardRate\`, \`PayrollServices\`).
- **Effective date** — the date a snapshot's rates begin to apply.
- **Cost / hr ($)** — what the firm pays this person per hour (one cost rate per snapshot).
- **$ / hr** — the billing rate for each rate code in the snapshot.
- **StandardRate** — required on every snapshot; used when an engagement's rate code has no matching entry.

## What you'll see
- The user **Rates** tab shows a **Current cost rate** card and the list of effective-dated billing rates.
- The **Rates** admin page shows **Loaded margin (current StandardRate vs cost)** with **Bill**, **Cost**, **Margin**, and **Effective** columns, plus \`cost missing\` and \`low margin\` pills.
- Resolve-debug shows **Won at level**, **Resolved rate**, **Engagement multiplier**, **Effective (multiplied)**, and a trace of each level's \`win\` / \`no-match\` / \`fallback\` status.

## Tips
- A time entry captures its rate at the moment of creation — the bill rate, the line amount (hours × rate), and the cost rate are all snapshotted onto the entry. Changing a staff rate later never reprices past entries, so historical reports never shift.
- The engagement's **Default rate code** decides which staff-rate code the resolver looks for; if there's no entry for that code, it falls back to \`StandardRate\`.
- An engagement premium/discount multiplier is applied to the bill rate before the snapshot is stored, so a discounted entry saves at the discounted rate. The multiplier never changes the cost rate.
- If no rate resolves for a person on an engagement, the app refuses the time entry rather than billing at zero — make sure every staff member has at least a \`StandardRate\` snapshot entry.
- Use **Bulk update (StandardRate, all staff)** on the **Rates** page to raise everyone's StandardRate by a percentage on a chosen effective date.
`),
  },
  {
    slug: 'rate-overrides',
    category: 'rates',
    title: 'Client & engagement rate overrides',
    summary: 'Override standard rates for specific work.',
    tags: ['rates', 'override', 'client', 'engagement'],
    sortOrder: 20,
    body: md(`
# Rate overrides & precedence

Beyond each staff member's standard billing rates, you can override a person's rate for a specific client, a specific engagement, or a service line. When a time entry is saved, the rate resolver walks these levels from most specific to least specific and uses the first one that matches and is in effect. This article explains the levels, the exact precedence order, and how effective dating breaks ties.

## Steps
1. Open the admin area and click **Rates** (\`/admin/rates\`).
2. To inspect or audit a person's overrides, find them in **Loaded margin** and click **History**. The **Rate history** dialog lists **Staff snapshots (per rate code)**, **Client overrides**, **Engagement overrides**, and **Service line rates**.
3. To confirm which level will win for a given situation, use the **Resolve-debug — why is this rate $X** panel: choose a **Timekeeper**, an **Engagement**, and a **Service date**, then click **Resolve**.
4. Read the **Trace** pills to see which level won and which were skipped, and expand **candidate(s) considered** to see every competing rate with its **Effective start** and **End**.

## Fields
- Override bill rate — every override level stores a bill rate per staff member.
- **Effective start** — the date the override begins to apply (required on all override types).
- **End** — optional close date (client overrides and service-line rates support one). An override applies when start ≤ service date < end.

## What you'll see
The resolver checks these levels in order and stops at the first match (most specific wins):
- **Engagement override** — this staff person on this engagement.
- **Client override** — this staff person on this client.
- **Service-line rate** — this staff person on the entry's service line.
- **Staff rate** — the staff snapshot entry for the engagement's **Default rate code**; if none exists, it falls back to the \`StandardRate\` entry (the trace shows \`fallback\`).
- **Firm default** — the final fallback. There is no firm-wide rate on the schema, so if nothing resolves the app refuses the time entry instead of billing zero.

## Tips
- There is **no work-code-level rate override**. Work codes affect in-scope tagging, not the rate; rate selection is driven by the engagement's rate code.
- When two rows at the same level are both in effect on the service date, the resolver picks the one with the most recent **Effective start**.
- Overrides are matched per staff member — an engagement or client override only applies to the specific person it was created for, not the whole team.
- Effective dating uses the entry's **service date**, not today's date, so backdated entries resolve against the rate that was in effect then.
- After the level wins, the engagement's premium/discount multiplier is applied to the resolved bill rate before it's snapshotted; the cost rate is never multiplied.
- Deleting an override is audit-logged and only affects future time entries — entries already saved keep their captured rate.
`),
  },

  // =================================================================== Pre-bills & Adjustments
  {
    slug: 'prebills-wip',
    category: 'prebill-adjustments',
    title: 'Pre-bills, billing batches & WIP',
    summary: 'Turn unbilled work into reviewable pre-bills.',
    tags: ['prebill', 'wip', 'billing batch'],
    sortOrder: 10,
    body: md(`
# Pre-bills, billing batches & WIP

A **billing batch** is the pre-bill. The staff app uses "billing batch" and "pre-bill" interchangeably; reach it under **Billing**.

## Steps
1. Open the **WIP** dashboard ("Firm-wide WIP") to see unbilled work, with filters for **Client**, **Engagement**, and **Client owner** and a "By engagement (largest first)" table.
2. Start a bill: click **Bill** on a single WIP row (pre-fills client, engagement, and period), or check several rows and click **Bill N selected** (prompts for **Period start**/**Period end**, one batch per engagement). Or use **Billing → Open a billing batch** directly.
3. Pick a **Client**, set **Period start**/**Period end**, choose a **Batch type** (**Standard** or **Retainer**).
4. Check one or more **Engagements** (Select all / Clear). Multiple = a consolidated bill ("one invoice covering N engagements. Surcharge and tax are skipped on consolidated bills"). Retainer batches are single-engagement.
5. Click **Create** to open the batch.
6. For each entry set the **Action**: **include**, **defer** (release to a future batch), or **write off**.
7. Optionally **Create adjustment** (see next article) or **Set target invoice amount** to auto-create the write-up/down for the delta; use **Invoice composition** for a memo + custom lines.
8. Click **Finalize** (status → **APPROVED**), then on an approved batch optionally tick **Offer retainer to client** and click **Generate invoice**.

## What you'll see
A status pill (**DRAFT / IN_REVIEW / APPROVED / INVOICED / CANCELLED**), summary figures (**Standard WIP (include)**, **Adjustments**, **Total to invoice**, **Defer**, **Write off**), a **WIP aging** panel (0-30 / 31-60 / 61-90 / 90+), an **AI pre-bill narrative** card (if AI is on), and an **Untracked client interactions** panel with **Convert** to log time from messages.

## Tips
- If an engagement's projected WIP exceeds its NTE cap, batch creation is rejected (\`nte_cap_exceeded\`).
- defer/write-off release the entry so a later pre-bill can pick it up — the time isn't lost.
`),
  },
  {
    slug: 'adjustments-allocation',
    category: 'prebill-adjustments',
    title: 'Adjustments & per-timekeeper realization',
    summary: 'Write a batch up/down and split it across timekeepers with one of six methods.',
    tags: ['adjustments', 'write-down', 'write-up', 'realization', 'allocation'],
    sortOrder: 20,
    body: md(`
# Adjustments & allocation

Open the dialog with **Create adjustment** on a DRAFT or IN_REVIEW batch ("Create adjustment — batch WIP $…"). It previews the per-timekeeper effect live.

## Steps
1. Set **Direction** — **Write-down** or **Write-up**.
2. Enter **Amount (USD)**.
3. Choose **Method** — Time / Fee / Rate.
4. Choose an **Allocation method** (below).
5. Pick a **Reason code** (filtered to write-down vs write-up codes) — **Create adjustment** stays disabled until one is chosen.
6. Optionally add **Notes**, review the **Per-timekeeper preview**, and click **Create adjustment**.

## The six allocation methods
- **Pro-rata by value** (default) — split across entries by each entry's dollar value.
- **Pro-rata by hours** — split by hours.
- **Partner absorbs** — distribute entirely across partner-role entries (fails if none).
- **Hierarchical cascade (junior held harmless)** — absorb from the top (partner → manager → senior → staff), sparing juniors until senior tiers are exhausted.
- **Specific entries** — caller-supplied per-entry amounts (must sum to the total).
- **Custom weighted** — per-timekeeper weights as percentages (sum to 100) or dollars (sum to the total).

## Per-timekeeper grain
Every allocation produces rows at the **(adjustment, time entry, timekeeper)** grain; realization rolls up from there. The preview shows Timekeeper · Role · Standard WIP · Adjustment · After · Realization %.

## Tips
- Pro-rata by value is the safe default. Partner absorbs requires a partner entry on the batch.
- In the current dialog, **Pro-rata**, **Partner absorbs**, and **Hierarchical cascade** submit directly; **Specific entries** and **Custom weighted** need per-entry/weight detail the dialog doesn't yet collect, so they may return a "required" error from there.
`),
  },
  {
    slug: 'adjustment-approvals',
    category: 'prebill-adjustments',
    title: 'Adjustment approvals & step-up',
    summary: 'Creating an adjustment needs a fresh second factor; large ones route for approval.',
    tags: ['adjustments', 'approval', 'step-up', 'threshold'],
    sortOrder: 30,
    body: md(`
# Adjustment approvals & step-up

Two gates protect adjustments.

## Step-up (fresh second factor)
Creating any adjustment requires a recent second-factor verification (the step-up window is **30 minutes** from your last verification). If it's stale, the create is rejected with "Your session needs a fresh TOTP step-up before creating adjustments. Verify in Account → Two-factor." Re-verify and retry. A passkey sign-in can itself satisfy step-up.

## Approval threshold
On submit, the amount is compared to the firm's **Adjustment approval threshold** (Admin → Firm settings; default **$1,000** when unset).
- **Over** the threshold → the adjustment is created **PENDING_APPROVAL**, routed to the client's **partner in charge** (with a ~48h SLA and an email if mail is configured). It doesn't affect the billed total until approved.
- **At/under** the threshold → applied immediately.

The approver acts in the **Approvals** queue (**Approve** / **Reject**).

## Tips
- Re-verify your second factor before a billing session so step-up doesn't interrupt you mid-adjustment.
- Lower the threshold for more partner oversight of small write-offs; raise it to reduce friction.
`),
  },

  // =================================================================== Invoicing
  {
    slug: 'creating-invoices',
    category: 'invoicing',
    title: 'Creating and sending invoices',
    summary: 'Finalize pre-bills into invoices and deliver them.',
    tags: ['invoice', 'billing', 'send'],
    sortOrder: 10,
    body: md(`
# Creating & sending invoices

## Steps
1. **Generate from a pre-bill** — finalizing an **APPROVED** (or IN_REVIEW) billing batch creates the invoice: it aggregates the included time net of adjustments, assigns a number (prefixed \`INV\`), sets the issue date to today and the due date from the client's terms, and creates it as **DRAFT**.
2. Open **Invoices** (titled "Invoices — N"; columns Invoice · Client · Issued · Due · Total · Paid · Status · Viewed). Filter by status, client, owner, and **Issued from / to**.
3. Click **Open** (or **PDF**) on a row to view the invoice.
4. Edit a draft with **Edit**: change each line's description/amount, **+ Add line**, or use **Add specific kind** (Time / Fixed fee / Milestone / Recurring fee / Expense / Custom). Click **Done**. (Editing is available only with no payments and not voided.)
5. **Send** a draft from the list with **Send** — it emails the client's billing contact and flips status to **Sent**.

## Render modes
The PDF supports a \`mode\` query value: \`summary\` (one aggregate line per kind), \`by-line\` (the line items — default), or \`full-detail\` (line items + a time-entry breakdown).

## Re-opening
On a **Sent**, unlocked invoice, **Re-open for editing** voids the current copy and creates a new **DRAFT** (number suffixed \`-r###\`) carrying manual lines forward; surcharge/tax recompute. An invoice with any recorded payment can't be re-opened/voided until the payment is reversed.

## What you'll see
The footer shows **Subtotal**, then **Surcharge**/**Sales tax**/**Processing fee** (only when non-zero), and **Total**. Surcharge/tax are auto-derived from the engagement's config and can't be edited directly. Consolidated invoices show one Time line per engagement and skip per-engagement surcharge/tax, following the client's consolidation preference.

## Tips
- To change surcharge/tax, edit the engagement's tax/surcharge config — the lines recompute on the next line-item change.
`),
  },
  {
    slug: 'quick-bills',
    category: 'invoicing',
    title: 'Quick bills (ad-hoc invoices)',
    summary: 'Bill a client ad-hoc without a pre-bill or standing engagement.',
    tags: ['quick bill', 'invoice', 'ad-hoc'],
    sortOrder: 20,
    body: md(`
# Quick bills

A quick bill is an ad-hoc invoice that isn't tied to a pre-bill or engagement — the "charge $250 right now" path. It has a simple lifecycle: **DRAFT → SENT → PAID**, with **VOID** reachable from any non-void state.

## What it needs
- A **client**, an optional **description**, and one or more **line items** (each with a name, optional description, quantity, and unit price). The total is quantity × unit price.

## Lifecycle
- Create it (starts **DRAFT**); edit its description or replace its lines while still **DRAFT**.
- **Send** it (must be DRAFT with a total greater than zero) → **SENT**.
- **Mark paid** (manual) from **SENT** → **PAID**.
- **Void** it with a reason from any non-void state.

## Permissions & notes
- Viewing needs \`invoice:read\`; creating/editing/sending/voiding needs \`invoice:write\`.
- Sending locks the line items — edits are rejected once it leaves DRAFT.

> Note: quick bills are currently driven through the API (\`/api/staff/quick-bills\`); a dedicated screen may not appear in every build.
`),
  },
  {
    slug: 'statements',
    category: 'invoicing',
    title: 'Statements of account',
    summary: 'Generate or email a client a summary of open invoices, payments, and aging.',
    tags: ['statements', 'account', 'balance', 'aging'],
    sortOrder: 30,
    body: md(`
# Statements of account

A statement summarizes a client's **SENT / PARTIALLY_PAID / OVERDUE** invoices (voided excluded) with a running balance and an aging breakdown.

## What it contains
- Each outstanding invoice as a debit row, with any successful payment shown right after as a credit, both carrying a running balance.
- Aging buckets: 0–30, 31–60, 61–90, 91–120, 121+ days past due, plus total due.
- A policy notice that balances over 90 days past due may have work suspended.

## How to produce one
- **One client** — generate the statement (HTML, or PDF).
- **Many clients** — bulk-generate a single combined PDF (one statement per page) for printing, or bulk-email each client their own statement PDF to their billing contact.
- Computed "as of" today; only invoices with a remaining balance are listed.

## Notes
- Requires the \`report:ar:read\` permission; bulk email needs mail configured.
- Statements are driven via \`/api/staff/statements\` in the current build.
`),
  },
  {
    slug: 'read-receipts',
    category: 'invoicing',
    title: 'Invoice read receipts',
    summary: 'The Viewed column shows when a client first opened an invoice in the portal.',
    tags: ['invoice', 'read receipt', 'viewed'],
    sortOrder: 40,
    body: md(`
# Read receipts

Vibe records when a client **first opens an invoice in the client portal** — there is **no email tracking pixel**, so the receipt fires only on a genuine portal view.

## Where you see it
The **Viewed** column on the **Invoices** list: a green date once the client has opened it, or muted "not yet" before then. The first-viewed timestamp is set once (on the first portal load) and doesn't change on later views; each view also writes an audit-log entry (viewer identity, IP, user agent).

## Tips
- Opening or previewing the invoice email does **not** mark it viewed — only a portal view does.
- Sending by SMS is a nudge to the portal link; it doesn't mark the invoice viewed.
- If **Viewed** stays "not yet" long after sending, check the client can reach the portal and the email's link is valid.
`),
  },

  // =================================================================== Payments
  {
    slug: 'payment-setup',
    category: 'payments',
    title: 'Setting up payment processing',
    summary: 'Bring your own Stripe or CPACharge account.',
    tags: ['payments', 'stripe', 'cpacharge', 'setup'],
    sortOrder: 10,
    body: md(`
# Setting up payment processing

Vibe is firm-owned: your firm supplies its own Stripe credentials and Stripe is the live processor. (CPACharge is scaffolded but not yet active — firm settings report it disabled.)

## Steps
1. **Set the Stripe keys on the appliance.** Stripe credentials are read from environment variables on the API container, not a settings form: \`STRIPE_SECRET_KEY\` and \`STRIPE_PUBLISHABLE_KEY\`. An operator sets them and restarts the API.
2. Go to **Admin → Firm settings → Billing and A/R**. Under **A/R options**, tick **Enable credit card processing** (lets staff charge cards on the Receive Payment page) and/or **Enable ACH processing**. Click **Save**.
3. (Optional, for proposals/recurring) **Admin → Stripe Connect** → **Connect Stripe** to link an account via OAuth.
4. To pass processor fees to a client, open the engagement, **Edit**, and turn on **Fee passthrough** ("Add processing fee line item on invoices").

## What you'll see
On **Admin → Stripe Connect**: if platform credentials aren't set, a **Not configured** pill (set \`STRIPE_CONNECT_CLIENT_ID\` + \`STRIPE_SECRET_KEY\` and restart); once connected, a **Connected account** card with **Refresh from Stripe** / **Disconnect** and a **Capabilities** card (Charges / Payouts / Details).

## Tips
- Keys live in the appliance environment so credentials never pass through the browser — hand this to whoever manages the appliance.
- The Receive Payment "Charge" mode is enabled only when Stripe is wired **and** credit card processing is on.
`),
  },
  {
    slug: 'recording-payments',
    category: 'payments',
    title: 'Receiving and recording payments',
    summary: 'Use the Receive payment page to record checks/cash or charge a card via Stripe.',
    tags: ['payments', 'ach', 'check', 'manual', 'receive', 'autopay'],
    sortOrder: 20,
    body: md(`
# Receiving payments

The **Receive payment** page handles money received outside Vibe (checks, cash, manual ACH) and live card charges via Stripe.

## Steps
1. Open **Receive payment** (from the AR area).
2. In **Record or charge**, pick a mode: **Record payment** ("Received via check, cash, other") or **Charge new payment** ("Process a card via Stripe" — only when Stripe + card processing are enabled).
3. Set **Payment date** and an optional **Reference no.** ("Check #, wire conf #, etc.").
4. **Record** mode: choose a **Payment method** (Check / Cash / ACH (manual) / Other, plus any custom methods). **Charge** mode is fixed to "Card via Stripe."
5. In **Amount**, enter **Amount received ($)** and pick the **Payee** (paying client). Use **Entities included** to add linked clients' invoices.
6. In **Outstanding transactions**, check each invoice to pay and adjust the per-row amount (selecting an invoice auto-allocates the entered amount up to its open balance).
7. Submit: **Record payment**, or **Charge $X** → enter card details → **Confirm charge**.

## What you'll see
An allocation summary ("Payment: $X allocated"). If you enter more than you allocate, "$X surplus → becomes a credit on submit" and an overpayment credit is created. A card charge cycles **Confirm charge → Confirming… → Awaiting Stripe…** and is finalized by the **Stripe webhook** (the source of truth) — if it's slow you'll see "Charge is still processing… check AR in a moment." When a payment fully pays an invoice, gated **pay-to-unlock** deliverables unlock and the portal contacts are emailed.

## Tips
- **Record** = money already in hand; **Charge** runs a card via Stripe. If you close the page mid-charge, the webhook still completes it — check AR.
- **Autopay** is a client-portal feature: clients enroll a saved card per engagement (Portal → Payment methods → Autopay enrollment), and the recurring-billing run charges it when an invoice is created.
`),
  },
  {
    slug: 'credits-refunds',
    category: 'payments',
    title: 'Credits and refunds',
    summary: 'Create/apply credit memos and process step-up-gated refunds.',
    tags: ['credits', 'refunds', 'overpayment'],
    sortOrder: 30,
    body: md(`
# Credits & refunds

A **credit memo** is money on file not yet applied to an invoice. Credits arise three ways: **manual**, **overpayment** (auto on Receive payment), and **refund excess**.

## Issue a credit (manual)
1. Open the client's **Billing** view → **Credits** card → **+ New credit**.
2. Fill **Issued** (date), **Amount ($)**, optional **Reference** and **Notes**, then **Add credit** (appears as source "manual", status **OPEN**).

## Apply a credit
On **Receive payment**, pick the payer so their open credits load, select the target invoice(s), then in **Open credits** choose the credit and **Apply to invoice** with an amount. To use only credits (no new money), leave **Amount received ($)** at 0 — the button reads **Apply $X from credits**. Credits can apply across entities within the same firm.

## Void a credit (step-up)
Voiding a memo prompts for a **Reason** and may re-prompt for your second-factor **step-up**; it cascades to active applications (sibling payments flip to refunded, invoice paid amounts drop).

## Refunds
A refund is processed against an invoice's most recent succeeded payment (step-up gated; needs \`invoice:write\`). It can be full or partial with an optional reason, calls the provider's refund (e.g. Stripe), marks the payment **REFUNDED**/**PARTIALLY_REFUNDED**, and reduces the invoice's paid amount. Excess beyond what the invoice needed becomes a **refund-excess** credit. A refunded pay-to-unlock deliverable reverts to hidden.

## Tips
- Credit statuses: OPEN → PARTIALLY_APPLIED → FULLY_APPLIED, or VOIDED — recomputed automatically.
- Refunds are currently driven via the API (\`/api/staff/invoices/:id/refund\`) in this build.
`),
  },

  // =================================================================== AR & Collections
  {
    slug: 'ar-aging',
    category: 'ar-collections',
    title: 'AR aging',
    summary: 'See who owes what, and how overdue.',
    tags: ['ar', 'aging', 'receivables'],
    sortOrder: 10,
    body: md(`
# AR aging & statements

The AR (accounts receivable) area shows every client's outstanding invoice balance, bucketed by how far past due it is, and lets you generate or email a statement of account. Open it from the **AR** item in the left navigation (the \`$\` icon, route \`/ar\`). Only invoices in \`SENT\`, \`PARTIALLY_PAID\`, or \`OVERDUE\` status count toward AR; \`DRAFT\`, \`PAID\`, and \`VOIDED\` invoices are excluded. Each invoice's balance is its total minus the amount paid, and rows with a zero-or-negative balance drop out automatically.

## Steps
1. Open **AR** from the left nav. The top card reads **AR aging as of <date>** with a \`live\` pill.
2. Read the four bucket totals: **0-30 days**, **31-60 days**, **61-90 days**, **90+ days**, plus a **Total**. The **90+** figure is shown in red.
3. In the **By client** card, narrow the list with the **Any owner** filter and/or the **Any client** filter.
4. Sort by clicking any column header (**Client**, **0-30**, **31-60**, **61-90**, **90+**, **Total**); click again to flip direction.
5. Page through results with **← Prev** / **Next →**, and set rows per page with the **50** / **100** / **200** selector.
6. To pull one client's statement, click the **Statement** button on that row — it downloads a statement-of-account PDF.
7. To act on many clients, tick the row checkboxes (or **Select all**). A bar shows **N clients selected** with **Generate statements (PDF)** (one combined PDF) and **Email statements** (emails each client's billing contact).
8. For a balance trend over time, go to \`/ar/snapshots\` — the **AR aging snapshot trend** card lists each **As of** date with the change vs. the prior snapshot.

## Fields
- **0-30**, **31-60**, **61-90**, **90+** — aging buckets measured in days past each invoice's due date.
- **Total** — the client's full outstanding balance across all buckets.
- **As of** — the snapshot or report date.

## What you'll see
- Balances roll up per client, then per firm for the top totals.
- The aging report exports to CSV and Excel (columns **Client**, **PartnerId**, **0-30**, **31-60**, **61-90**, **90+**, **Total**).
- A single-client statement lists each open invoice as an **Invoice** row plus any **Payment** credit rows, with a running balance, and a five-band aging summary (**0-30**, **31-60**, **61-90**, **91-120**, **121+**) — a finer split than the four-bucket aging report.
- Statements carry firm branding (logo, accent color, support contacts) and a policy notice that work is suspended on balances over 90 days past due. The A/R Terms text from firm settings prints in the footer.
- Bulk generate/email skips clients with no outstanding balance and reports how many were generated vs. skipped.

## Tips
- A nightly job snapshots per-client aging (around 12:30 AM) — the trend page is empty until it has run at least once.
- Statements and the aging report read the same balances, so the numbers always agree.
- Bulk actions cap at 200 clients per request; email is skipped for any client without a billing-contact email.
- Set the A/R Terms and branding under **Admin → Firm settings** so statements render correctly.
- Viewing AR requires the \`report:ar:read\` permission.
`),
  },
  {
    slug: 'dunning',
    category: 'ar-collections',
    title: 'Dunning reminders',
    summary: 'Automated overdue-invoice reminders.',
    tags: ['dunning', 'reminders', 'overdue', 'collections'],
    sortOrder: 20,
    body: md(`
# Collections & dunning reminders

Dunning is the automated past-due follow-up that runs in the background. An hourly worker sweep scans invoices that are \`SENT\`, \`PARTIALLY_PAID\`, or \`OVERDUE\` with a due date on or before today, and fires the reminder steps that haven't yet been sent for each invoice. Steps escalate as an invoice ages, and the system records every attempt.

## Steps
1. Let the schedule run automatically — the \`dunning-sweep\` job runs hourly. No per-invoice setup is required.
2. Customize the wording under **Admin → Firm settings** in the **Dunning messages** section, with five fields: **1 Period old**, **2 Periods old**, **3 Periods old**, **4 Periods old**, **5 Periods or older**.
3. To send a one-off reminder now, open **Invoices**, find the invoice, and click **Remind** (available unless the invoice is \`DRAFT\`, \`PAID\`, or \`VOIDED\`). It emails the client's billing contact.
4. Respect the cooldown: if a reminder went out in the last 24 hours, the **Remind** button is disabled and its tooltip shows how long ago the last one was sent.
5. Review history per invoice via the dunning-history record (each step's kind, channel, recipient, and outcome).
6. Audit all outbound dunning under **Admin → Notifications** (**Outbound notifications**), filterable by **Window**; failures keep their error text.
7. Trigger a manual sweep for testing under **Admin → Jobs** — click **Run now** next to \`dunning-sweep\`.

## Fields
- **Remind** — sends an immediate friendly reminder email for that invoice.
- **Dunning messages 1-5** — per-period message text in firm settings.
- **Window** — time range filter on the outbound notifications log.
- **Run now** — enqueues a one-off run of a scheduled job.

## What you'll see
- The default cadence fires by days overdue: day 7 \`REMINDER_FRIENDLY\` ("Friendly reminder: invoice past due"), day 21 \`REMINDER_FIRM\` ("Past due notice"), day 45 \`REMINDER_ESCALATED\` ("Urgent: invoice significantly past due"), day 60 \`PARTNER_NOTIFY\` ("Past due — partner escalation"), day 90 \`AUTO_PAUSE\` ("Service pause notice").
- Channel is email when the billing contact has an email; otherwise SMS if a billing phone exists; otherwise the step is logged but not delivered.
- At day 60 the engagement's partner-in-charge also gets an escalation email.
- At day 90 the primary engagement is automatically set to \`PAUSED\` (no new time entries) and the change is audit-logged.
- Each step is recorded once per invoice (a step never double-fires), and an invoice still in \`SENT\` flips to \`OVERDUE\` once a step fires.
- Every send is also written to the client's communication timeline as an \`OUTBOUND\` \`dunning\` entry.

## Tips
- Automatic and manual reminders share the same 24-hour cooldown, so a manual **Remind** won't stack on top of a recent automated step.
- To stop the cycle for a client, resolve the balance — paying, marking paid, or voiding removes the invoice from the sweep. There is no per-client "pause dunning" toggle.
- The sweep processes up to 500 overdue invoices per run.
- Email/SMS only deliver when the firm has configured a provider; otherwise steps are recorded as not dispatched.
`),
  },

  // =================================================================== Client Portal
  {
    slug: 'portal-overview',
    category: 'client-portal',
    title: 'Client portal overview',
    summary: 'What clients can do and how access works.',
    tags: ['portal', 'clients', 'license'],
    sortOrder: 10,
    body: md(`
# Client portal overview

The client portal is a separate, branded web app (served from your firm's \`portal.\` subdomain) where your clients sign in to view and pay invoices, exchange messages and files, respond to requests, and review engagements, statements, and tax items. It runs as its own application — distinct from the staff app — with its own login and its own session.

## What you'll see
- The portal is **commercial-license-gated**. If the appliance has no commercial license token configured, the portal shows a full-page **Portal unavailable** message reading "This appliance does not have a commercial license token configured." Clients cannot even reach the login form.
- The portal can also be turned off per-firm. When a firm disables it, the same **Portal unavailable** page instead reads "Your firm has disabled the client portal." Both states point the client to "Contact your firm administrator for help."
- The portal header shows your firm's branding (logo + display name) when configured; otherwise it falls back to **Client Portal**. A green \`portal\` realm badge sits in the header.
- The left navigation a signed-in client sees: **Overview**, **Engagements**, **Appointments**, **Invoices**, **Messages**, **Requests**, **Letters**, **Files**, **Tax payments**, **Tax returns**, **Statement**, **Payment methods**, **Profile**, **Activity**, **Switch client**, and **Notifications**.
- On **Invoices**, clients see "Open invoices" and "Paid" cards, can open an invoice to see line items and payments, **View as PDF**, **Download receipt**, and pay an open balance with a \`Pay $<amount>\` button.
- On **Messages**, clients pick a thread and reply with a **Send** button.
- On **Requests**, clients see "Open requests" and "History," open a request to read it, post a reply, and mark it complete.
- On **Files**, clients browse folders and **Download** files.

## Tips
- The portal is intentionally scoped to one client account at a time (the session's active client). Clients with access to multiple entities use **Switch client** — see the alternate-contacts / multi-entity article.
- **Session isolation is absolute.** Staff and portal sessions never cross: they use distinct cookies, distinct paths, and distinct JWT signing keys. A staff sign-in is never valid in the portal and vice versa.
- The only way staff see the portal exactly as a client does is the **View as client** button on the client record (read-only, short-lived session). See "Inviting a client to the portal."
- Portal sign-in is passwordless: clients authenticate with an emailed magic link or an SMS one-time code. There is no separate password to manage.
`),
  },
  {
    slug: 'inviting-clients',
    category: 'client-portal',
    title: 'Inviting a client to the portal',
    summary: 'Send a portal invitation and manage access.',
    tags: ['portal', 'invite', 'access', 'magic link'],
    sortOrder: 20,
    body: md(`
# Inviting a client to the portal

Staff grant portal access from the client's record, in the **Portal access** card. Each person you invite becomes a portal identity that can sign in on behalf of that client. This article covers sending an invitation, what the client does, identity verification, and managing access afterward.

## Steps
1. Open the client's record and find the **Portal access** card.
2. Click **+ Invite to portal** (top-right of the card). The button toggles to **Cancel** while the form is open.
3. Fill in the invite form: **Full name**, a **Role**, an **Email** and/or **Phone (E.164)**, and the **Send invitation via** channel.
4. Click **Send invitation**. You'll see "Invitation email queued to …" / "Invitation text queued to …", or — if that contact already has a portal identity at your firm — "That contact already has a portal identity at this firm — access added immediately."
5. The client opens the invitation and accepts; their access flips to **ACTIVE** and they land on the portal home.

## Fields
- **Full name** — required free text (e.g. \`Jane Doe\`).
- **Role** — one of **Full access** (\`FULL\`), **View only** (\`VIEW_ONLY\`), or **Pay only** (\`PAY_ONLY\`). Defaults to **Full access**.
- **Email** — optional; standard email format.
- **Phone (E.164)** — optional; must be E.164 format (e.g. \`+15555550123\`).
- **Send invitation via** — **Email** or **Text message**. Defaults to **Email**.
- Name plus at least one of email or phone is required; otherwise the form reports "Check the form — name plus either email or phone is required."

## What you'll see
- After sending, a new entry appears under **Pending invitations** showing the name, contact, role pill, an "Awaiting acceptance" pill, and an **Expires** date (invitations expire in 7 days).
- Each pending invitation has a **Resend** button. Resending issues a new link and invalidates the previous one ("the previous link is now invalid").
- Once accepted, the person moves into the access list with a role pill and a status pill (**ACTIVE**, **INVITED**, or **INACTIVE**), the contact summary, and a "last signed in" date when available.
- Expanding an access row shows: **Portal identity ID**, **Email verified**, **Phone verified**, **Invited**, **Accepted**, **Revoked** (if applicable), and **Identity status**.

## Identity verification
- Sign-in is passwordless. Email contacts get a magic link valid for 15 minutes; phone contacts get a 6-digit SMS code.
- **Phone re-verification happens on every new device** (fingerprinted by IP + user-agent); on a mismatch the portal sends an SMS one-time code to confirm the new device before issuing a session.
- The first SMS verification also captures TCPA SMS consent for the audit trail.

## Managing access
- **Change role / edit identity:** Expand a row, change the **Role** dropdown and/or edit **Full name**, **Email**, **Phone (E.164)**, then **Save changes**.
- **Revoke access:** Expand an active row and click **Revoke access**. The person is signed out and blocked from future sign-ins (status → **INACTIVE**). This is reversible.
- **Restore access:** Expand an inactive row and click **Restore access** to set it back to **ACTIVE**.
- **View as client:** On an **ACTIVE** row, click **View as client ↗** to open the portal in a new tab exactly as that person sees it — read-only, and the launch link is single-use and short-lived.

## Tips
- Granting portal access requires the \`client:portal-access:manage\` permission.
- Inviting a contact that already has an identity at your firm skips the email/SMS round-trip and grants access immediately (deduped by firm + email or firm + phone).
- Bulk invites are supported via CSV with the header \`fullName,email,phone,role,deliveryChannel\`.
`),
  },
  {
    slug: 'portal-alt-contacts',
    category: 'client-portal',
    title: 'Alternate contacts & multi-entity access',
    summary: 'Give several people access, scoped correctly.',
    tags: ['portal', 'contacts', 'multi-entity'],
    sortOrder: 30,
    body: md(`
# Alternate contacts & multi-entity access

A portal identity is one person who can hold access to several client accounts at your firm, and who can verify more than one email or phone for sign-in and notifications. This article explains how that works and what the client manages themselves.

## Multi-entity access
- One identity, many entities: a single person can be invited to multiple clients. All their accesses live behind one sign-in. The portal sign-in screen states this directly: "One person, multiple entities — your accesses live behind a single sign-in."
- The active session is always scoped to one client at a time (the session's active client).
- The client switches entities on the **Switch client** page (**Switch active client** card), which lists each client they can access, their **role** there, and which one is currently **active**. Clicking **Switch** changes the active client and reloads.
- When a client has access to more than one entity, the **Switch client** page also shows a **Consolidated view** card with a "Show entries across all my clients" toggle. When on, the **Invoices**, **Tax payments**, **Engagements**, and **Activity** pages aggregate entries across every client they can access. It does not change which client is active for actions like making a payment.

## How staff add multi-entity access
- To give an existing portal user access to another entity, open that other client's record and invite the same person (same email or phone) via **+ Invite to portal**. Because the system dedupes by firm + contact, their existing identity gains a new access row immediately rather than creating a duplicate identity.

## Alternate contacts (client-managed)
Clients add and verify their own alternate emails/phones on the portal's alternate-contacts page (reached from **Profile**).

## Steps
1. The client opens the **Add an alternate contact** card.
2. They choose a **Channel** — **Email** or **SMS**.
3. They enter the value in the **Email address** or **Phone (E.164)** field.
4. They click **Send code**; the portal sends a verification code and shows "Verification code sent."
5. In the **Enter verification code** card they type the **6-digit code** and click **Verify**; on success they see "Contact verified."

## What you'll see
- The **Saved alternate contacts** table lists each contact with **Channel**, **Address**, and a **Status** pill (**verified** or **unverified**).
- Unverified rows offer an **Enter code** button; every row has a **Remove** button (with a "Remove this contact?" confirmation).

## Tips
- A contact can be re-added to reset its code; the system upserts on (identity, channel, value) rather than duplicating, and limits sends to roughly one per minute.
- Removing or adding alternate contacts is something the client does themselves; staff edit only the identity's primary name/email/phone from the **Portal access** card.
`),
  },

  // =================================================================== Proposals
  {
    slug: 'services-packages',
    category: 'proposals',
    title: 'Services catalog & packages',
    summary: 'Define what you sell before you propose it.',
    tags: ['services', 'packages', 'catalog', 'pricing'],
    sortOrder: 10,
    body: md(`
# Services catalog & packages

Before you can build a proposal, your firm defines the *services* it sells and (optionally) bundles them into *packages*. Both feed directly into the proposal editor's "Services list" and "Package selector" blocks. This article covers defining services with tags, building packages, and who can manage them.

## Steps
1. Open the services catalog at \`/admin/services\` (Admin sidebar → **Services catalog**). The header reads "Services catalog — Define the services your firm bills for. Used by proposals + engagements."
2. (Optional) Set up tags first. In the **Tags** card, type a name into the \`Tag name\` field, pick a color, and click **Add tag**. Hover a tag to **rename** or **×** (delete) it.
3. Click **New service** to open the editor card.
4. Fill in **Name**, **Category**, **Billing type**, **Default price (USD)**, and optionally **COA code** and **Add-on of (parent)**.
5. If billing type is \`recurring\` or \`split deposit recurring\`, a **Recurring interval** field appears — pick one.
6. Add a **Description (Markdown)** and toggle any **Tags** at the bottom of the editor.
7. Click **Create service** (or **Save changes** when editing).
8. To raise/cut prices in bulk, check several services, click **Bulk price… (N)**, choose **Percent delta** or **Flat delta**, enter a value, and click **Apply**.
9. To build a bundle, open \`/admin/packages\` (Admin → **Packages**). Use the **Add tier** form, then select a tier card to attach services, set override prices, and toggle \`included\`.

## Fields
- **Category** — one of \`TAX\`, \`BOOKKEEPING\`, \`AUDIT\`, \`ADVISORY\`, \`PAYROLL\`, \`CFO\`.
- **Billing type** — \`ONE_TIME\`, \`RECURRING\`, \`ON_COMPLETION\`, or \`SPLIT_DEPOSIT_RECURRING\`.
- **Recurring interval** — \`MONTHLY\`, \`QUARTERLY\`, \`SEMIANNUALLY\`, or \`ANNUALLY\` (required only for recurring billing types).
- **Default price (USD)** — entered in dollars, stored as cents.
- **COA code** — optional chart-of-accounts code.
- **Add-on of (parent)** — links this service as an add-on under a parent service.

## What you'll see
- The services grid shows Name, Category, Billing, Default price, Tags, and a Status pill (\`Active\` or \`Archived\`).
- Archiving a service is a **soft delete** — it hides from the default list but stays in the database so existing proposals and engagements still reference it. Check **Include archived** to see archived rows, then **Restore** them.
- Packages display grouped by name; each tier shows its included total and an included-service count.

## Tips
- Tags only group services for filtering and selection — deleting a tag just untags its services, it does not delete them.
- There is no hard delete in v1; every service is archived rather than removed to keep proposal/engagement history clean.
- Bulk price is floored at $0 — values can't go negative. Percent is entered as a number (e.g. \`5\` = +5%, \`-5\` = -5%).
- Editing services and packages requires \`service:write\`; viewing requires \`service:read\`. Every change is audit-logged.
- Use **Duplicate** on a package tier to clone its services into a new tier quickly.
`),
  },
  {
    slug: 'proposals-overview',
    category: 'proposals',
    title: 'Building and sending proposals',
    summary: 'Assemble a proposal and send it for e-signature.',
    tags: ['proposals', 'engagement letter', 'e-sign', 'send'],
    sortOrder: 20,
    body: md(`
# Building and sending proposals

Proposals are branded, block-based documents you assemble from your services catalog, packages, and terms templates, then send to a client via a secure magic link. The client reviews it section by section, signs electronically, and acceptance automatically converts the proposal into an engagement.

## Steps
1. Go to **Proposals** (\`/proposals\`). The header reads "Proposals — Draft, send, and track engagement proposals."
2. Click **New proposal**. On the "New proposal" page pick a **Client** and enter a **Title**, then click **Create + open editor**.
3. In the editor, use the **Add block** palette to drop in blocks: \`Cover\`, \`Markdown text\`, \`Heading\`, \`Divider\`, \`Video\`, \`Services list\`, \`Package selector\`, \`Terms\`, and \`Signature\`.
4. Configure each block by selecting its row. For **Services list**, check the services to show and toggle "Show prices in the rendered list." For **Package selector**, pick one package. For **Terms**, choose a terms template.
5. Drag the \`⋮⋮\` handle to reorder; use **Undo**/**Redo** (or Ctrl/Cmd+Z). The editor autosaves about every 2 seconds; click **Save now** to flush immediately.
6. Resolve any validation issues (shown inline and as a counter pill), then click **Send proposal**. This snapshots the document as version 1 with a SHA-256 content hash and flips status \`DRAFT → SENT\`.
7. Mint a client link; the system returns a URL of the form \`<portalBaseUrl>/p/<token>\`. Deliver it to the client. Re-minting supersedes the prior unused link.
8. Track progress on the pipeline dashboard (kanban, funnel, time-to-sign, abandoners, stale proposals).

## Fields
- **Client**, **Title** — set on creation; title is editable only while \`DRAFT\`.
- \`Markdown text\` supports merge tokens like \`{{ client.name }}\`, \`{{ firm.name }}\`, \`{{ today }}\` resolved at send time.
- **Signature** block: a field label (default "Type your full legal name to sign") and acceptance copy.
- Magic-link lifetime defaults to 30 days (1–180 allowed).

## What you'll see
- Status pills: \`DRAFT\`, \`SENT\`, \`VIEWED\`, \`IN_PROGRESS\`, \`ACCEPTED\`, \`DECLINED\`, \`EXPIRED\`, \`CANCELLED\`, \`COUNTERED\`. The list shows one-time and recurring fee totals plus a revision (\`v#\`) column.
- When the client first opens the link, status advances \`SENT → VIEWED\` and a first-viewed timestamp is stamped.
- Section-by-section tracking records dwell time per section/session, so you can see which sections the client lingered on.
- A **Versions** panel shows each immutable snapshot with its content hash — what the client saw at send time hashes to that value forever.

## Tips
- Clients can optionally create a password account (email + Argon2id password) from a magic-link session so they can return without a fresh link.
- A proposal can only be edited while \`DRAFT\`; sending locks the content. Cancelling sets status \`CANCELLED\` (not allowed once \`ACCEPTED\`).
- On acceptance the system records the signature + per-firm HMAC, optionally captures an ACH mandate, marks the selected package, snapshots a final \`ACCEPTED\` version, and **freezes the scope into a new engagement**. This conversion is idempotent.
- Magic-link redemption is rate-limited per IP (10/hour); tokens are 256-bit random and stored only as SHA-256 hashes.
- The funnel values an engagement as one-time + 12 × recurring; filter the dashboard by date range, owner, and value.
`),
  },
  {
    slug: 'renewals',
    category: 'proposals',
    title: 'Renewals',
    summary: 'Renew recurring engagements and proposals.',
    tags: ['renewals', 'recurring', 'pipeline'],
    sortOrder: 30,
    body: md(`
# Renewals

The renewal engine surfaces active engagements approaching their end date and helps you roll them forward into fresh proposals — optionally with a price uplift. It does the candidate detection and the uplift math; you choose the strategy per candidate.

## Steps
1. Run a scan. By default it looks **90 days** ahead (\`daysAhead\`, 1–365). The scan finds \`ACTIVE\` engagements whose end date falls between today and the cutoff and that don't already have an open renewal.
2. Each new candidate is created in state \`CANDIDATE\` with a send window running from 30 days before the engagement's end date through the end date itself.
3. List candidates, ordered by send-window end (soonest first).
4. For a candidate, choose an uplift mode and recompute the suggested total (only while state is \`CANDIDATE\`):
   - \`MANUAL_PERCENT\` — supply \`manualBps\` (basis points; 500 = +5%).
   - \`REALIZATION_BASED\` — supply prior billed/billable amounts and an optional target realization (defaults to 100%).
   - \`CPI_INDEXED\` — uses a CPI-U year-over-year snapshot to set the uplift.
5. (Optional) Toggle the **auto-renew** flag. The UI gates this behind prior client consent.

## Fields
- \`daysAhead\` — scan horizon, default 90.
- \`mode\` — \`MANUAL_PERCENT\`, \`REALIZATION_BASED\`, or \`CPI_INDEXED\`.
- \`manualBps\` — uplift in basis points for manual mode.
- \`autoRenew\` — boolean flag on the renewal candidate.

## What you'll see
- Each candidate carries the engagement name, client name, end date, current fee, the chosen uplift mode/bps, the suggested total, state, send-window dates, and the auto-renew flag.
- Uplift responses include a human-readable reason, e.g. \`Manual 5.00%\`, \`Realization 82.0% vs target 100.0% → +21.95%\`, or \`CPI-U YoY 3.00% (2024-12 → 2025-12)\`.
- Realization uplift returns +0% ("already meets target") when prior realization is at or above target, and holds at 0 when there's no prior data.

## Tips
- Scan is idempotent — running it again won't duplicate a candidate that's already \`CANDIDATE\` or \`PROPOSED\`.
- Uplift can only be recomputed while the candidate is still \`CANDIDATE\`.
- Basis-point convention: 10000 bps = 100%, so "target 100%" is \`10000\`.
- Renewal actions require \`engagement:write\` (\`engagement:read\` to list). Every scan, uplift, and auto-renew toggle is audit-logged.
`),
  },

  // =================================================================== Tax Returns
  {
    slug: 'tax-returns-overview',
    category: 'tax-returns',
    title: 'Tracking and releasing tax returns',
    summary: 'Record status and deliver returns through the portal.',
    tags: ['tax', 'returns', '1040', 'k-1', 'release'],
    sortOrder: 10,
    body: md(`
# Tracking and releasing tax returns

The Tax area is where your firm tracks finished tax returns and delivers them to clients through the portal. It is a tracking-and-delivery workflow, not a tax-preparation tool: returns are prepared in your tax software, then flagged or parsed into the app so you can review their sections, release the right pages to the right client, and see who has viewed them. Open it from the **Tax** nav entry, which lands on the **Returns** tab.

## Steps
1. On the **Returns** tab, the table lists every return with columns **Client**, **Year**, **Form** (\`formCode · jurisdiction\`), **Title**, **Type**, **Status**, **Pages**, and **Released**.
2. If no returns exist yet you'll see **"No tax returns yet"** — returns appear once parsed into the system.
3. Click a client name to open that return's detail page.
4. Review the header card, the **Client**, the **Sections** card, and the **Active releases** card.
5. Click **Release to client** to open the **Release tax return to client** dialog.
6. In **Released to client (UUID)**, confirm or change the target client (defaults to the return's own client).
7. Choose a **Scope**: **Full return** (every page) or **Selected sections** (a section picker appears).
8. For **Selected sections**, tick sections to include (each shows its title and page range \`pp {start}–{end}\`). At least one section is required.
9. Set **Client can download the PDF** on or off (on by default; off means view-only).
10. Optionally add a **Cover note (optional)** (up to 2000 characters).
11. Click **Release**. The new release appears under **Active releases**.
12. To pull back access, click **Revoke** on a release row and confirm. The client loses access immediately.

## Fields
- **Status** — \`DRAFT\`, \`PARSED\`, \`REVIEW\`, \`APPROVED\`, \`RELEASED\`, or \`SUPERSEDED\`.
- **Type** (release kind) — \`ORIGINAL\`, \`AMENDED\`, or \`SUPERSEDED\`.
- **Scope** — \`FULL\` or \`SELECTED\`. Withheld sections never appear to the client.
- **Sections** — each has a title, a kind (e.g. \`COVER\`, \`MAIN_FORM\`, \`SCHEDULE\`, \`K1\`, \`STATE\`), and a page range.

## What you'll see
- The detail page shows **Sections (n)** with titles and page ranges, and **Active releases (n)** listing who each release went to, the scope (**Full return** or **N sections**), whether download is enabled, and the release date.
- Selective releases are enforced server-side: with **Selected sections**, the client's viewer only shows the released sections — they never learn the withheld ones exist.
- Listing and viewing require \`engagement:read\`; creating and revoking releases require \`engagement:write\`.

## Tips
- A return with no parsed sections can only be released as **Full return**.
- Clients can re-share a release with a third party (e.g. a bank or lender) from their own portal as a tokenized recipient link with optional 2FA, an expiry, view-only or view-and-download, and a watermark. Staff see active shares in the viewer's "Shared with" rail.
- To preview exactly what a client sees, use **View as client ↗** on the client's **Portal access** card. It opens the portal read-only; the launch token is single-use and expires 5 minutes after it's issued.
- Every release, revoke, view, and section edit is written to the return's access log for audit.
`),
  },
  {
    slug: 'tax-payments',
    category: 'tax-returns',
    title: 'Tax payments tracking',
    summary: 'Show clients scheduled tax payments.',
    tags: ['tax', 'payments', 'estimates', 'jurisdiction'],
    sortOrder: 20,
    body: md(`
# Tax payments tracking

Tax payments let your firm record a client's tax obligations — by jurisdiction and payment type, with amount and due date — so they show up on the client's portal home with a "pay online" link where available. Staff record and maintain these; clients only view them. You can manage payments per client (Client detail → **Tax payments** card) or firm-wide (Tax page → **Payments** tab).

## Steps
1. Open a client and find the **Tax payments** card.
2. Click **+ Schedule tax payment** to open the inline composer.
3. Pick a **Jurisdiction** from the dropdown (only active jurisdictions appear).
4. Pick a **Payment type** — the list is filtered to the chosen jurisdiction. Types with a pay-online link show \`(online)\`.
5. Optionally set **Engagement (optional)**, **Tax year**, and **Internal notes (not shown to client)**.
6. Enter **Amount (USD)** (e.g. \`2500.00\`) and **Due date**.
7. Click **Schedule**. The payment is created with status \`SCHEDULED\`.
8. When the client pays, click **Mark paid** on the row, enter **Paid date** and an optional **Confirmation number**, then **Confirm**.
9. To cancel a scheduled payment, click **Void** and enter a reason. Only \`SCHEDULED\` payments can be voided; \`PAID\` payments cannot.

## Fields
- **Jurisdiction** / **Payment type** — stored as text so the row survives later catalog edits.
- **Payment URL** — the pay-online link, snapshotted from the catalog at create time so it stays stable; surfaced to the client as a link.
- **Amount (USD)** — entered in dollars, stored in cents.
- **Internal notes** — firm-internal only; never sent to the client.
- **Status** — \`SCHEDULED\`, \`PAID\`, or \`VOIDED\`.

## What you'll see
- The client card shows **Scheduled**, **Overdue**, and **Total scheduled** stats, plus a table with **Jurisdiction**, **Type**, **Amount**, **Due** (red when a scheduled item is past due), and **Status**.
- The firm-wide **Payments** tab (titled **Tax payments — firm-wide**) adds per-column filters (status, due-from/to, client, jurisdiction, payment type), sortable headers, and a checkbox column. Selecting rows enables **Send reminder**, which sends one message per client per channel (**Email** and/or **SMS**) summarizing the selected payments, with an optional note.
- In the portal, the client sees only \`SCHEDULED\` and \`PAID\` payments (and \`PAID\` only within the last 90 days); \`VOIDED\` rows and internal notes are hidden.

## Tips
- Viewing requires \`tax_payment:read\`; creating, editing, marking paid, voiding, and sending reminders all require \`tax_payment:write\`. Clients can never create or modify payments.
- A scheduled payment can only be edited while still \`SCHEDULED\`; once \`PAID\` it is terminal.
- If no jurisdictions are configured, the composer points you to **Admin → Catalog → Tax payments**.
- Reminders need email/SMS providers configured; clients with no active portal contact are reported as skipped.
`),
  },

  // =================================================================== Retainers
  {
    slug: 'retainers-overview',
    category: 'retainers',
    title: 'Retainers',
    summary: 'Configure tiers, offer, activate, and track retainers.',
    tags: ['retainer', 'prepaid', 'tiers'],
    sortOrder: 10,
    body: md(`
# Retainers

A retainer is a block of prepaid hours a client buys for a specific tax engagement. Eligible time logged against that engagement draws down the retainer instead of going to billable WIP. When the hours run out the retainer is \`exhausted\`; on its expiry date any unused hours forfeit. Retainers are firm-gated, sold in two tiers per return type, and visible to clients in the portal with a live balance and ledger. This is an opt-in feature — until a partner turns it on, no offers are created and the portal pages stay hidden.

## Steps
1. Turn the feature on at \`/admin/retainer-tiers\` (requires \`retainer:tier_config:write\` — partner-only). In **Firm-level retainer settings**, check **Feature enabled** (the pill flips to **ON**), then **Save settings**.
2. Set the offer rules: **Offer window (days from invoice date)** (default 60), the biller-toggle default, and the **Prep-fee work codes** set (lines on a tax-prep invoice with these codes count toward the offer basis).
3. Choose the **Reminder cadence** (**On-bill**, **Day 30**, **Day 55**) and optionally fill **GL revenue account** / **GL offset account**.
4. Configure tiers per return-type tab (\`1040\`, \`1065\`, \`1120\`, \`1120S\`, \`1041\`, \`990\`). Fill **Tier 1 — Standard** and **Tier 2 — Premium**, then **Save tiers**. Each tier needs at least one eligible work code.
5. Let offers auto-create on a qualifying tax-prep invoice, or create one manually on the partner dashboard (\`/admin/retainers\`) → **Create retainer**.
6. In the form, pick **Bill the client** (creates a sent AR invoice; retainer waits in \`pending_payment\` and activates when paid) or **Already paid (record only)** (active immediately). Select **Engagement** and **Tier**, optionally override **Hours** / **Price**, then **Create**.
7. Watch drawdown on the dashboard or in **My retainers** (\`/my/retainers\`). Open a retainer to see its ledger; export it as CSV.
8. Manage an active retainer from the dashboard: **Pause** (time routes to WIP), **Resume**, or **Void** (only when zero hours are consumed).

## Fields
- **Feature enabled** — master switch; off hides offers and portal pages but keeps the schema installed.
- **Hours covered** — prepaid hours for the tier.
- **Base fee ($)** + **Pct of prep fee (basis points, 100 = 1%)** — price = base fee + (pct × prep-fee basis).
- **Eligible work codes** — the work codes a retainer covers once activated (snapshotted at activation).

## What you'll see
- Dashboard KPIs: **Active**, **Tier 1/Tier 2 active**, **Hours sold/consumed (12mo)**, **Utilization**, **Expiring 90d**, **Open offers**, **Purchased/Declined/Expired 90d**.
- Status pills: \`active\`, \`exhausted\`, \`paused\`, \`expired\`, \`void\`, and \`awaiting payment\` (for \`pending_payment\`).
- In the portal, clients see hours purchased/consumed, expiry, status, a privacy-filtered ledger (no staff names or notes), and a downloadable Retainer Activity Statement PDF.
- Notification emails on activation, on exhaustion, and expiry warnings at 90/60/30/7 days before expiry.

## Tips
- Eligibility is locked in at activation: changing a tier's work codes later does not affect already-active retainers.
- One retainer per engagement. Void (zero hours only) to free the engagement for a new offer.
- A time entry only draws down when the retainer is \`active\`, the entry date is on or before the expiry date, and the work code is eligible; otherwise it goes to billable WIP.
- Editing or deleting a time entry reverses its consumption, and an exhausted retainer can flip back to \`active\`.
- Unused hours forfeit on the expiry date — no refund or rollover.
`),
  },
  {
    slug: 'hour-banks',
    category: 'retainers',
    title: 'Hour banks',
    summary: 'Prepaid hours, drawdown, rollover, and forfeiture.',
    tags: ['hour bank', 'prepaid hours', 'rollover', 'forfeit'],
    sortOrder: 20,
    body: md(`
# Hour banks

An hour bank is a prepaid block of hours attached to an engagement, drawn down as work is performed. Unlike retainers (which target a tax return and two fixed tiers), an hour bank is a simple ledger: an opening balance plus top-ups, minus debits, expirations, and forfeitures. The balance is always computed from the transaction ledger — opening hours never change. Residual hours forfeit when the engagement closes (no refund, no credit). The staff web app provides read-only **Hour banks** and **Hour-bank transactions** views; most actions run through the API.

## Steps
1. View banks on the **Hour banks** page (requires \`engagement:read\`). Each row shows the client, engagement, opening hours, opening amount, expiry, and status.
2. Create a bank with an engagement, opening hours, opening amount, and optional rollover cap / expiration date (requires \`engagement:write\`).
3. Check a balance — remaining = opening + \`PURCHASE\` top-ups − (\`DEBIT\` + \`EXPIRE\` + \`FORFEIT\`).
4. Draw down hours with a debit; a debit larger than the available balance is rejected with \`insufficient_hours\`.
5. Top up — writes a \`PURCHASE\` transaction tagged \`manual_top_up\`.
6. Configure auto-replenish — enable it, set a threshold and a target, and optionally a rollover cap.
7. Forfeit residual on close (requires \`engagement:archive\`) — writes a \`FORFEIT\` transaction for the remaining balance, zeros the running balance, and stamps a forfeited timestamp. A bank can only be forfeited once.
8. Review history on **Hour-bank transactions** — pick a bank from the **Hour bank:** dropdown and read the ledger.

## Fields
- **Opening hours / amount** — the starting balance and its dollar value; never mutated.
- **Rollover cap** — ceiling the post-replenish balance is clamped to; auto-replenish never pushes above it.
- **Expiration date** — date after which the daily worker expires the remaining balance.
- **Auto-replenish threshold / target** — when the balance drops below the threshold, the worker refills it to the target.

## What you'll see
- On **Hour banks**: an \`ACTIVE\` pill, or a \`FORFEITED\` pill once forfeited or expired. Expiry shows \`—\` when none is set.
- On **Hour-bank transactions**: columns **When**, **Kind**, **Hours**, **Amount**, **Running**, **Note**. Transaction kinds are \`PURCHASE\`, \`DEBIT\`, \`EXPIRE\`, \`FORFEIT\`, \`REFUND\`.
- Auto-replenish top-ups appear as \`PURCHASE\` rows tagged \`auto_replenish\`; expirations as \`EXPIRE\` rows tagged \`expiration\`; engagement-close forfeitures as \`FORFEIT\` rows tagged \`engagement_close\`.

## Tips
- Auto-replenish only fires when both threshold and target are above zero and the balance has dropped below the threshold; the top-up cost is derived from the original opening rate per hour.
- If a rollover cap is set and the balance is already at or above it, auto-replenish skips that bank.
- The expiration worker writes a single \`EXPIRE\` transaction for the whole remaining balance, then marks the bank forfeited.
- Residual hours forfeit on engagement close — set clear forfeit language in the engagement letter so clients aren't surprised.
- Balance is always recomputed from the ledger, so transactions are append-only; there is no edit/delete.
`),
  },

  // =================================================================== Files
  {
    slug: 'files-overview',
    category: 'files',
    title: 'Files & storage',
    summary: 'Where documents live and how storage is configured.',
    tags: ['files', 'storage', 'b2', 'minio'],
    sortOrder: 10,
    body: md(`
# Files & storage

Every client document the firm uploads lives in object storage, organized into one storage folder per client. This article covers where files live, how an administrator points the appliance at a storage backend in **Admin → Storage**, how existing folders are matched to clients during onboarding, and how staff upload files from a client's Files tab.

## Steps
1. Open **Admin → Storage** to reach the **File storage backend** page.
2. Under **Provider**, pick one of **Mock (local filesystem, dev only)**, **Backblaze B2 (S3-compatible)**, or **MinIO (self-hosted S3)**.
3. For B2, fill in **Endpoint**, **Region**, **Bucket**, **Key ID**, and **Application Key**. For MinIO, fill in **Endpoint**, **Region**, **Bucket**, **Access key**, and **Secret key**.
4. For B2 or MinIO, click **Test connection** to verify credentials before saving.
5. Click **Save settings**. On success you'll see "Settings saved." and a restart banner.
6. Restart the appliance so the new provider takes effect (saving does not hot-swap the live storage client).
7. To attach existing bucket folders to clients, open **Storage onboarding** and use **Scan** / **Bind**.
8. To add a file to a client, open the client record's **Files** tab and click **Upload**.

## Fields
- **Provider** — \`mock\`, \`b2\`, or \`minio\`. \`mock\` writes to the appliance's local filesystem under \`/data/storage-mock\`.
- **Endpoint** / **Region** / **Bucket** — the S3-compatible target.
- **Key ID** + **Application Key** (B2) or **Access key** + **Secret key** (MinIO). Secrets are masked once saved; the stored value shows as \`(saved · …)\` and the secret field shows \`(saved — leave blank to keep)\`.

## What you'll see
- A warning banner after save: "Restart the appliance" for the new provider to take effect; existing uploads do not auto-migrate.
- A **Test connection** result line: \`Connection OK · <ms>\` or \`Connection failed: <error>\`.
- A **Last tested …** line showing the timestamp and tested provider.
- In the client **Files** tab: a **Storage folder** card (path, status, **Last synced**, **Refresh**, **Rename folder**), a **Folders** subfolder list, and a file table. Files mid-upload show a \`pending\` pill.

## Tips
- Credentials are sealed with the firm key before they hit the database, so a DB dump never leaks them.
- Re-type the masked Key ID / access key to save changes; leaving the masked hint in place blocks the save.
- \`mock\` is fine for dev or a single host; choose B2 or MinIO for production durability.
- Saving credentials never migrates files already stored on the previous provider.
`),
  },
  {
    slug: 'sharing-and-visibility',
    category: 'files',
    title: 'Sharing files & visibility rules',
    summary: 'Control what clients can see and download.',
    tags: ['files', 'share', 'visibility', 'escrow'],
    sortOrder: 20,
    body: md(`
# Sharing files & visibility rules

A client file is \`private\` by default until staff publish it. This article covers flipping file visibility (single and bulk), the firm-level default rules that pre-set visibility per subfolder, the escrow / pay-to-unlock flow that releases deliverables when an invoice is paid, the client-side share links, and how to resolve folder-binding conflicts.

## Steps
1. In a client's **Files** tab, click a file's **Visibility** pill to flip between \`🔒 private\` and \`👁 visible\` (\`client_visible\`).
2. To flip many at once, select files and use the bulk **Make client visible** / **Make private** actions in the toolbar.
3. To set firm-wide defaults, an admin opens the visibility-rules editor, adds rows of subfolder pattern → default visibility with a priority, and saves the pack.
4. To gate a deliverable behind payment, set a file's visibility to \`escrow\` and supply the gating invoice; it auto-promotes to \`client_visible\` when that invoice is paid.
5. A partner can force-release or re-gate an escrow file via the escrow-override action (requires a reason of at least 10 characters).
6. To resolve a folder-binding conflict, open **Storage conflict resolution** and choose \`keep_current\`, \`reassign\`, or \`unbind_both\`.

## Fields
- File visibility values: \`private\`, \`client_visible\`, \`escrow\`. Escrow requires a gating invoice.
- Firm rule: subfolder pattern, default visibility (\`private\` or \`client_visible\`), priority (0–1000), enabled, notes.
- Escrow override: target visibility (\`escrow\` or \`client_visible\`) plus a reason (10–500 chars).
- Conflict resolution: action (\`keep_current\` / \`reassign\` / \`unbind_both\`) plus a reason (≥10 chars for reassign/unbind).
- Client share link (portal-created): expiry in days, access level (\`view\` or \`download\`), optional note.

## What you'll see
- Publishing requires \`storage:file:publish\`; making a file private requires \`storage:file:unpublish\` (asymmetric — buttons disable with a tooltip naming the missing permission).
- When an invoice is paid, every \`escrow\` file tied to it flips to \`client_visible\`, gets a promoted timestamp, and the firm can notify the client. Refunding or voiding the invoice reverts those auto-promoted files back to \`escrow\`.
- The conflict screen shows the currently-bound client, the challenger, name-match scores, and a recommended action with rationale.

## Tips
- Every visibility change is recorded to the file's event history for the portal "first viewed" audit and compliance exports.
- Escrow override audit rows are tagged so manual releases are distinguishable from natural payment-driven flips.
- Share links are created by the **client** in their portal, not by staff; the raw token appears exactly once and the row stores only its SHA-256 hash. Clients revoke a share via the revoke action (idempotent).
- Manual \`client_visible\` files (no gating invoice) are never touched by the refund/void revert.
`),
  },
  {
    slug: 'document-requests',
    category: 'files',
    title: 'Document & information requests',
    summary: 'Collect items from clients and turn returns into time.',
    tags: ['requests', 'documents', 'collection', 'pbc'],
    sortOrder: 30,
    body: md(`
# Document & information requests

A client request is a checklist the firm sends to a client for documents, questions, or signatures, tracked against an engagement. This article covers creating requests (from scratch or a template), items, bulk-sending, reminders, how the client responds in the portal, and converting a fulfilled request into a time-entry suggestion.

## Steps
1. Create a request against an engagement. Provide a **title** (or a template whose pattern supplies one), optional body, priority, due date, assignee, and a list of items.
2. Add items, each with an ordinal, a **label**, optional body, an item kind of \`QUESTION\`, \`DOCUMENT\`, or \`SIGNATURE\`, and a **required** flag.
3. To send one template to many clients at once, use **bulk send**: pick a template and a list of targets (each client + engagement, with optional due-date / priority / assignee overrides).
4. Set **reminder days before** so the daily worker emails the client when the due date is within that many days.
5. The client opens the request in their portal and replies, marks it needs-info, attaches a file, or fulfills individual items.
6. When all required items are fulfilled, the request rolls up to \`FULFILLED\`. Staff can also fulfill, dismiss, or reopen a request.
7. On fulfill, a time-entry suggestion is queued for the assignee; in **suggestions/mine** you accept it (attaching a time entry) or dismiss it.

## Fields
- Request: engagement, title, body, assignee, due date, template, priority (\`LOW\`/\`MEDIUM\`/\`HIGH\`/\`URGENT\`), tags, reminder-days-before, items.
- Item: ordinal, label, body, item kind (\`QUESTION\`/\`DOCUMENT\`/\`SIGNATURE\`), required, due date.
- Template: key, name, title pattern, body pattern, default priority, default due offset, default reminder days, default assignee, item rows.

## What you'll see
- Request statuses include \`OPEN\`, \`NEEDS_INFO\`, \`FULFILLED\`, and \`DISMISSED\`.
- A fulfilled request enriched with its linked time entry shows hours, entry date, and staff name in the list and detail.
- Reminder emails carry the subject "Reminder: <title> — due <date>" and are sent at most once per day per request.
- Explicit fields sent at create time always override template defaults.

## Tips
- Creating/editing requests requires \`requests:manage\`; reading requires \`requests:read\`. Template CRUD is gated by \`taxonomy:write\` (read by \`taxonomy:read\`).
- Bulk send skips targets whose engagement doesn't belong to the firm or doesn't match the given client, and reports them as skipped.
- A suggestion's expiration is firm-configurable (default 7 days); the queue is sorted by soonest expiry.
- Reopening a request clears its fulfilled / dismissed metadata and flips it back to \`OPEN\`.
`),
  },

  // =================================================================== Messaging
  {
    slug: 'engagement-messaging',
    category: 'messaging',
    title: 'Secure engagement messaging',
    summary: 'Encrypted, engagement-scoped conversations.',
    tags: ['messaging', 'encryption', 'threads'],
    sortOrder: 10,
    body: md(`
# Secure engagement messaging

Every engagement has a private, encrypted message thread shared between your staff and the client's portal contacts. Threads are scoped to a single engagement (and its client), every message body is encrypted at rest, and clients read and reply through the branded portal — never email.

## Steps
1. Open **Messages** from the staff navigation. The left card is titled **Threads (N)**; the right card shows the selected conversation.
2. Pick a thread on the left. Each row shows the thread title (or "Engagement thread" if untitled) and either "Updated <date/time>" or an **Archived** pill.
3. Read the stream on the right. Staff messages align right and are tagged \`· staff\`; client messages align left and are tagged \`· client\`.
4. To reply, type in the composer (placeholder "Type a reply… (Ctrl/Cmd+Enter to send)") and click **Send**, or press Ctrl/Cmd+Enter.
5. From a thread linked to an engagement, click **Open engagement →** in the header to jump to that engagement.
6. From an engagement's detail page, use the **Messages** card to read and reply inline, or click **Open in inbox →** for the full thread.
7. On a client's record, the client messages card lets you switch threads or click **+ New thread** to start a client- or engagement-scoped conversation.

## Fields
- **Threads (N)** — count of threads you are a member of.
- Thread title — defaults to "<Client name> — conversation" for client-direct threads; engagement threads may be untitled.
- Sender label — "<name> · staff" or "<name> · client".
- Composer — free-text body, 1 to 10,000 characters.

## What you'll see
- Threads are created automatically when an engagement is opened with portal contacts assigned; staff don't create engagement threads from the inbox.
- You only see threads you are a **member** of. Membership mirrors engagement assignments plus the client's partner-in-charge; a removed member loses access.
- If you aren't a member: "You aren't a member of this thread. Ask the engagement partner to add you, then refresh."
- Archived threads show an **Archived** pill and block new replies ("This thread is archived. Reopen the engagement to send a reply."). Threads archive when the engagement is archived.
- Read receipts are recorded per reader; opening a message marks it read.

## Tips
- Encryption is at-rest: each thread has its own data-encryption key wrapped by the firm key, and the appliance must be unlocked to read or send. Staff and clients never see ciphertext.
- There is **no file-attachment feature in the message thread** — share documents through the engagement's file-sharing tools instead.
- Clients reply from the portal; your sent message appears there immediately.
- During pre-bill review, the **Untracked client interactions** panel surfaces thread messages in a date range that aren't yet linked to a time entry — useful for capturing unbilled communication.
- Reading requires \`messaging:read\`; posting requires \`messaging:write\`.
`),
  },
  {
    slug: 'notification-templates',
    category: 'messaging',
    title: 'Notification templates',
    summary: 'Customize the emails and texts clients receive.',
    tags: ['notifications', 'templates', 'email', 'sms', 'variables'],
    sortOrder: 20,
    body: md(`
# Notification templates

The app sends automated client and sign-in notifications from per-event templates. You can override the baked-in defaults per event and per channel (email or SMS). Templates are plain text with \`{{variable}}\` markers — there is no HTML or Markdown editor; you insert variables from a picker and the dispatcher substitutes real values at send time.

## Steps
1. Open the admin **Notification templates** page.
2. Review the event list. Each row shows the event label and, for each supported channel, a status pill: \`EMAIL override\` / \`SMS override\` (a custom template exists) or \`EMAIL default\` / \`SMS default\` (using the baked-in default).
3. Click **Edit** next to the channel you want to change. The editor opens titled "Edit <kind> · <channel>".
4. For email, fill in **Subject**. For all channels, fill in **Body**.
5. Insert variables from the **Variables** list — click a \`{{variable}}\` button to append it to the body.
6. Click **Save**. A confirmation reports how many variables were detected ("Saved. Detected N variable(s).").
7. To remove a custom template and fall back to the default, click **Revert to default**.
8. To populate any event/channel pair that has no template yet, click **Seed missing defaults** ("Existing overrides preserved.").

## Fields
- **Subject** — email only; omitted for SMS.
- **Body** — required; the text sent, with \`{{variable}}\` markers.
- **Variables** — picker buttons. Available names include \`client.name\`, \`client.primaryContact\`, \`invoice.number\`, \`invoice.total\`, \`invoice.due_date\`, \`invoice.balance\`, \`firm.displayName\`, \`firm.supportEmail\`, \`firm.supportPhone\`.

## What you'll see
- Events and their channels: **Invoice sent** (EMAIL), **Invoice overdue** (EMAIL, SMS), **First dunning** (EMAIL, SMS), **Second dunning** (EMAIL, SMS), **Payment received** (EMAIL), **Magic link sign-in** (EMAIL), **SMS OTP** (SMS).
- Variables are detected by scanning the subject and body for \`{{ name }}\` patterns; the count is recorded in the audit log.
- Unset templates use the firm's baked-in defaults, so notifications still send even before you customize anything.

## Tips
- Variable insertion only: do not paste HTML or Markdown expecting it to render — the body is sent as text with values substituted.
- A channel that an event doesn't support shows no pill or Edit button (e.g. **Invoice sent** has no SMS option).
- Provider configuration (which SMTP/Postmark/Resend/SES service sends email, and TextLink/Twilio/SNS for SMS) is set separately — templates control content, not delivery.
- Reverting deletes the override row entirely; the default immediately takes over.
`),
  },

  // =================================================================== Reporting
  {
    slug: 'reporting-overview',
    category: 'reporting',
    title: 'Reporting & the analytics cube',
    summary: 'Realization, utilization, profitability, AR, and recurring revenue.',
    tags: ['reports', 'realization', 'utilization', 'profitability', 'mrr'],
    sortOrder: 10,
    body: md(`
# Reports & analytics

The **Reports** workspace (left-nav **Reports**, at \`/reports\`) is the firm's analytics hub. It opens with a **Report library** card of jump-to tiles, a **Filters** card, and a stack of live report cards.

## Steps
1. Open **Reports** from the left navigation.
2. In the **Report library** card, pick a tile: **Payments received ★**, **Realization**, **Revenue ops**, **Engagement profitability**, **Subscription profitability**, **Billable targets**, **Capacity forecast**, **WIP dashboard**, **AR aging**, **AR snapshots**, or **Audit log**.
3. Set a date window in **Filters**: type a **Start** and **End** date, or click a preset — **7d**, **30d**, **90d**, **12m**. Use **Clear dates** to reset.
4. In the **Realization** card, switch the lens with the **firm**, **timekeeper**, **engagement**, or **client** buttons.
5. Click any row label in a dimension table to drill in (the card title shows "Realization (drilled)"). Click **✕ Clear drill** in **Filters** to exit.
6. Export the current realization view with the **↓ CSV** link, or **⬇ Excel** on **Revenue operations**.
7. Optionally use **Ask in plain English** to ask a question and have the AI suggest which reports to run.

## Fields
- **Start** / **End** — date-range filter (note: these apply to realization; other cards use their own fixed windows).
- Realization dimension buttons — **firm**, **timekeeper**, **engagement**, **client** (the API also supports a service-line dimension).
- **Standard WIP** — original standard value; **After adjustments** — adjusted value; **Realization** — adjusted ÷ original, as a percent (green at ≥ 90%, otherwise amber).

## What you'll see
- **Revenue operations (last 90 days)**: **Billed**, **Paid**, **DSO**, **Collection rate**, **MRR (N plans)**, with sparklines and prior-period deltas. DSO turns amber above 60 days; collection rate amber below 80%.
- **Subscription profitability (trailing 90 days)**: per recurring plan, trailing revenue, in-scope/OOS hours, and a **Margin** pill (green ≥ 50%, amber ≥ 25%, else red).
- **Billable-hour targets · current month**: per-timekeeper **Hours**, **Variance**, **Attainment** (firm target default 130h).
- **Capacity forecast · next 4 weeks**: weekly average, projected 4-week hours, and a **Variance** pill vs the weekly target (default 32h).
- **Realization**: firm summary stats or a drillable dimension table sorted worst-realization first.
- Dedicated pages: **Payments Received** (\`/reports/payments-received\`) and **Engagement profitability** (\`/reports/profitability\`).

## Tips
- Filter settings persist in the page URL — copy the address bar to share an exact report view.
- Reports are gated by reporting permissions (e.g. \`report:realization:read\`, \`report:profitability:read\`, \`report:utilization:read\`, \`report:partner-data:read\`); payments-received needs \`payment:read\`.
- Exports are CSV/Excel; there is no PDF export for these reports.
- Click **✨ Explain this** under the firm realization stats for an AI narrative.
`),
  },
  {
    slug: 'saved-reports',
    category: 'reporting',
    title: 'Saved reports & scheduled email',
    summary: 'Save report views and have them emailed.',
    tags: ['reports', 'saved', 'scheduled', 'email'],
    sortOrder: 20,
    body: md(`
# Saved reports

A saved report stores a report configuration — a name, a report kind, and a \`params\` payload — so you can rerun it later or share it firm-wide. Manage them under **Admin → AI & Integrations → Saved reports** (\`/admin/saved-reports\`).

## Steps
1. Go to **Admin**, open the **AI & Integrations** group, and click **Saved reports**.
2. In the **Save a report definition** card, type a **Name**.
3. Choose a **Report kind**: \`realization\`, \`profitability\`, \`utilization\`, \`effective-rate\`, \`dso\`, \`mrr\`, \`book-of-business\`, \`clv\`, \`scope-creep\`, or \`revenue-period-over-period\`.
4. Enter **Params JSON** — a JSON object of filters for that kind, e.g. \`{"dimension":"timekeeper"}\` or \`{"days":30}\`. Leave it as \`{}\` for defaults.
5. Tick **Shared firm-wide** to let other staff see it (read-only); leave it unticked to keep it private.
6. Click **Save**.
7. Review existing definitions in the **Saved reports** table; click **Delete** to remove one you own.

## Fields
- **Name** — label for the definition (1–120 characters).
- **Report kind** — which report the params apply to.
- **Params JSON** — a JSON object; invalid JSON shows "Params JSON is invalid" and blocks saving.
- **Shared firm-wide** — when on, the report shows a \`firm-wide\` pill; otherwise \`private\`.

## What you'll see
- The **Saved reports** table lists **Name**, **Kind**, **Params** (the raw JSON), **Shared** (a \`firm-wide\` or \`private\` pill), and a **Delete** action.
- You see your own saved reports plus any marked shared by colleagues.
- Editing or deleting is owner-only.

## Tips
- Scheduling is via the params payload, not a dedicated UI: a background worker scans saved reports for a \`schedule\` block of the shape \`{ "schedule": { "enabled": true, "recipients": ["a@firm.com"], "cron": "..." } }\` and emails the named recipients. Add that block to **Params JSON** to enable it.
- Scheduled emails send only when a mail provider is configured; otherwise the worker logs a no-op.
- To rerun, recreate the filters in the report itself using the saved **Params JSON** as your guide — the keys mirror the report's own query parameters (e.g. \`dimension\` for realization, \`days\` for windowed reports).
- Keep shared reports generic; private reports are best for ad-hoc param experiments.
`),
  },
  {
    slug: 'anomaly-scope-creep',
    category: 'reporting',
    title: 'Scope creep & anomaly detection',
    summary: 'Spot out-of-scope spikes and unusual entries.',
    tags: ['scope creep', 'anomaly', 'alerts'],
    sortOrder: 30,
    body: md(`
# Scope-creep & anomaly detection

The app watches for engagements drifting out of scope and for unusual activity, and surfaces the results in two places: the live **Reports** workspace and the **Alerts** inbox (\`/alerts\`). Detection runs both on-demand (report endpoints) and in background workers that write immutable alert events into the audit log.

## Steps
1. For a live view, open **Reports**; the scope-creep report ranks mixed-mode engagements by out-of-scope share of total hours.
2. To review flagged events, open **Alerts** from the left navigation.
3. Read the **Inbox · worker alerts** table for **scope creep**, **audit anomaly**, **wip age**, and **engagement rollover** rows.
4. Triage with the **When**, **Kind**, **Subject**, and **Summary** columns; the **Subject** is the affected engagement or actor.
5. Optionally click **✨ Summarize these alerts** in the **AI summary** card for a plain-language rollup.

## Fields
- Scope-creep metrics: **totalHours**, **outOfScopeHours**, and **creepPct** (out-of-scope ÷ total), sorted highest first.
- Scope-creep alert payload: creepPct, windowDays, totalHours, outOfScopeHours, threshold.
- Audit-anomaly alert payload: actor kind (staff/portal), actor id, events-last-hour, threshold.

## What you'll see
- A **scope creep** alert summary like "23.4% out-of-scope hours over 30d" with an amber pill.
- An **audit anomaly** alert when an actor exceeds N events/hour, with a red pill.
- The **Realization** report flags low realization (green at ≥ 90%, otherwise amber) — the realization "anomaly" lens for write-down drift.
- A time-anomaly report highlights days where a timekeeper's daily hours deviate sharply from their own 90-day pattern.
- Alerts are read-only and immutable — they live in the append-only audit log.

## Tips
- Scope-creep: the worker scans \`ACTIVE\` mixed-mode engagements over a 30-day lookback and fires when out-of-scope share is at or above the threshold (default 20%). The same engagement is suppressed for 7 days after an alert.
- Audit-anomaly: an actor exceeding ~80 audit events in the last hour is flagged (default), with 1-hour per-actor suppression.
- Time-entry anomaly detection flags daily hours at or beyond 2.5 standard deviations from the timekeeper's own 90-day mean (needs at least 5 active days to evaluate).
- Only mixed-mode engagements are scoped for creep — out-of-scope tagging comes from per-entry in-scope flags set at time-entry creation.
- An AI scope-creep narrative can turn the flagged list into a partner-facing summary plus one recommendation, when an AI provider and budget are available.
`),
  },

  // =================================================================== Approvals
  {
    slug: 'approvals-overview',
    category: 'approvals',
    title: 'Approvals & the approval queue',
    summary: 'Route sensitive actions for sign-off.',
    tags: ['approvals', 'queue', 'workflow', 'multi-step'],
    sortOrder: 10,
    body: md(`
# Approvals dashboard

The **Approvals** page is where designated approvers act on items that exceed firm-configured thresholds or rules — most commonly write-up/write-down adjustments over the firm's dollar threshold. Approvers can approve or reject, leave comments, and (where multi-step routing applies) advance an item to the next approver.

## Steps
1. Open **Approvals** from the staff navigation. The card is titled **Pending approvals (N)**.
2. Scan the table: **Type**, **Requested by**, **When**, **Entity**, and **Step**.
3. Click **Review** on a row to open the inline decision controls.
4. Optionally type into the **Optional comments** field.
5. Click **Approve** to approve, or **Reject** to reject. Click **Cancel** to back out.
6. The row leaves the pending list once decided; the table refreshes automatically.

## Fields
- **Type** — the entity under review, shown lower-cased (e.g. \`adjustment\`, \`rate change\`).
- **Requested by** — the staff member who submitted the item.
- **When** — when it was requested.
- **Entity** — the first 8 characters of the entity's ID.
- **Step** — for multi-step routing, a "current / total" pill (highlighted on the final step); single-step items show \`—\`.
- **Optional comments** — free text saved with the decision.

## What you'll see
- Entity types that can appear: \`ADJUSTMENT\`, \`PRE_BILL\`, \`INVOICE\`, \`ENGAGEMENT_LETTER\`, \`RATE_CHANGE\`.
- Adjustments over the firm's adjustment-approval threshold (default $1,000, firm-configurable) are created in \`PENDING_APPROVAL\` and routed to the client's partner-in-charge with a default 48-hour SLA. Final-step approval flips the adjustment to \`APPLIED\`; rejection flips it to \`REJECTED\`.
- Your queue shows items assigned to you plus any unassigned pending items.
- On a multi-step item, approving an intermediate step advances it to the next approver and it stays pending; only a final-step approval or any rejection closes it.

## Tips
- Approving or rejecting requires the \`approval:act\` permission; viewing the queue requires \`approval:queue:read\`.
- Approval **rules** (entity type, conditions, approver resolution, SLA and auto-escalate hours, priority) are configured on the admin **Approval rules** page.
- Auto-rollover collisions do **not** appear in this queue. They surface as read-only items on the **Alerts** page (\`engagement_rollover\`); the partner then drives the rollover from the engagement rather than an approve/reject decision here.
- Decisions are audit-logged with the approver, step, and comments.
`),
  },

  // =================================================================== AI
  {
    slug: 'ai-overview',
    category: 'ai',
    title: 'AI features & the support assistant',
    summary: 'What AI does and the local-first model.',
    tags: ['ai', 'assistant', 'ollama', 'anthropic', 'chat'],
    sortOrder: 10,
    body: md(`
# AI features overview

The app ships with an optional, **local-first** AI layer that powers in-app drafting, narratives, and a knowledge-base-grounded support chat. Nothing leaves your appliance unless an administrator explicitly enables cloud egress.

## What AI powers
- **Ask AI support chat** — the **Ask AI** tab under **Help & Support**. It retrieves your firm's published Knowledge Base articles and answers using only those articles, with clickable source chips below each reply.
- **Time entry description suggestions** — one-sentence draft descriptions from engagement, work code, and hours context.
- **Realization, scope-creep, capacity, anomaly, and pre-bill narratives** — plain-English partner summaries that wrap the rule-based reports.
- **Pricing renewal suggestions** — a fee/effort/notes block on the **AI usage** admin page.
- **Reason-code and adjustment suggestions**, **plain-English query**, and **natural-language to filter** helpers.

## Multi-provider abstraction
- All features call one \`AiProvider\` interface, so the same feature runs on any wired provider.
- Three provider implementations exist: local \`Ollama\`, \`OpenAI-compatible\` (Groq, Together, vLLM, LM Studio, llama.cpp server, etc.), and cloud \`Anthropic\` Claude.
- Routing is **local-preferred**: even when cloud is permitted, the local provider is used unless a per-feature override pins it to cloud.

## Budget cap (warn 80% / hard cap 100%)
- Each firm has a monthly AI budget in cents plus a warn threshold.
- At or above the warn threshold (default **80%**), successful AI responses include a \`warn\` flag with remaining budget.
- At **100%** of the monthly budget, AI calls are blocked with an \`ai_budget_exhausted\` error and a reset date (the first of next month, UTC). Local Ollama calls are costed at $0, so a local-only firm effectively never exhausts the cap.

## Egress policy / Vibe Shield
- The default per-firm policy is **local-only**: every AI call uses the local provider and cloud is never reached.
- When AI egress is enabled, cloud calls are allowed **only** while Vibe Shield is reachable (status cached by a healthcheck worker). If Shield is unreachable or unconfigured, the call fails safe and falls back to local.
- A cloud override requested on a local-only firm is silently downgraded to local.

## What you'll see
- A consistent **✨ AI · <feature>** panel header on each embedded feature, with a small provider-id tag.
- The **AI usage** admin page shows status, request counts, tokens, cost, and a per-feature breakdown.
- Panels render nothing when AI is disabled or no provider is wired, so screens stay clean.

## Tips
- Keep AI fully local for maximum data sovereignty — no setup beyond a local model is required.
- Narrative features only receive aggregated counts/totals, not client PII.
- If Ask AI says it can't answer, browse the **Knowledge Base** tab or ask a firm administrator.
`),
  },
  {
    slug: 'enabling-ai',
    category: 'ai',
    title: 'Enabling AI & the cost cap',
    summary: 'Configure a provider, egress policy, and budget.',
    tags: ['ai', 'enable', 'budget', 'egress', 'shield'],
    sortOrder: 20,
    body: md(`
# Enabling & configuring AI

AI is configured by environment variables (which provider is wired) plus admin settings (budget and provider preference).

## Steps
1. **Choose and wire a provider** in the appliance environment. Exactly one local provider is built from env, plus an optional cloud provider:
   - Local \`Ollama\`: set \`AI_LOCAL_MODEL\` (e.g. \`qwen3:8b-q4_K_M\`); optionally \`AI_LOCAL_URL\` (defaults to \`http://localhost:11434\`).
   - \`OpenAI-compatible\`: set \`AI_OPENAI_BASE_URL\` (this elects the OpenAI path), plus \`AI_OPENAI_API_KEY\`, \`AI_OPENAI_MODEL\`, and optional cost-per-token vars.
   - Cloud \`Anthropic\`: set \`AI_CLOUD_API_KEY\`; \`AI_CLOUD_MODEL\` has a built-in default.
2. Open **Admin → AI usage** to confirm provider wiring under the **AI status** card.
3. Open **Admin → Firm settings** and set **AI monthly budget ($) — Q14**.
4. Set **AI provider preference — Q15 / Phase 23 #6** to one of **Default (local-first)**, **Force local (Ollama)**, or **Force cloud (Anthropic)**.
5. To allow cloud calls at all, an admin must enable AI egress and configure a Vibe Shield endpoint in firm config; otherwise the firm stays local-only.
6. Leave AI enabled, or disable all AI features by setting \`VIBE_AI_DISABLED=true\` in the environment.

## Fields
- **AI monthly budget ($) — Q14** — the per-firm monthly cap. Warn fires at the firm's warn threshold (default 80%); hard cap at 100%.
- **AI provider preference — Q15 / Phase 23 #6** — **Default (local-first)**, **Force local (Ollama)**, or **Force cloud (Anthropic)**.
- **AI egress / Vibe Shield endpoint** (firm config) — gate that must be on, with a reachable Shield, before any cloud call is made.

## What you'll see
- The **AI status** card on **Admin → AI usage** shows three pills: **Status** (\`enabled\`/\`disabled\`), **Opted in** (\`yes\`/\`no\`), and **Provider** (the provider id or \`none\`).
- A note states you can toggle AI off via \`VIBE_AI_DISABLED=true\` and set per-feature overrides with \`VIBE_AI_FEATURE_<NAME>=local|cloud\`.
- Staff-facing AI panels appear only when the firm is opted in, enabled, and a provider is wired.

## How staff see AI availability
- The web app calls \`/api/staff/ai/status\` once per session and caches the result.
- A panel is shown only when status reports \`enabled\`, \`optedIn\`, and \`providerWired\` are all true.
- When AI is unavailable, the **Ask AI** tab shows "Ask AI is not enabled" and points staff to enable a provider and to use the **Knowledge Base** tab.

## Tips
- Setting \`AI_OPENAI_BASE_URL\` takes precedence over \`AI_LOCAL_MODEL\` for the local slot — use it for hosted gateways or on-prem inference servers.
- Local providers cost $0, so a local-only firm can leave the budget conservative without blocking work.
- Use per-feature overrides (e.g. \`VIBE_AI_FEATURE_REALIZATION_NARRATIVE=cloud\`) to route only specific features to cloud; overrides are still blocked by the egress policy.
`),
  },
  {
    slug: 'mcp-server',
    category: 'ai',
    title: 'MCP server for AI agents',
    summary: 'Let AI agents act in the app with scoped tokens.',
    tags: ['mcp', 'ai', 'agents', 'tokens', 'automation'],
    sortOrder: 30,
    body: md(`
# MCP server for AI agents

The MCP (Model Context Protocol) server lets external AI agents call this firm's tools with **full read and write** access, scoped per token. Every mutating call is audit-logged with the token as the actor.

## What the MCP server exposes
- **Read tools:** \`list_engagements\`, \`get_time_entries\`, \`query_recurring_plans\`, \`query_realization\`, \`suggest_adjustment\` (computes a suggestion but does not write), \`list_unresolved_client_requests\`, \`summarize_engagement_thread\`, \`suggest_billable_messages\`, \`draft_pre_bill_narrative\`.
- **Write tools:** \`create_time_entry\`, \`generate_pre_bill\` (creates a billing batch from unbilled entries), \`link_message_to_time_entry\`.
- All tools are firm-scoped: cross-firm requests are rejected.

## Steps
1. Open **Admin → API tokens**.
2. In the **Create MCP token (Q13)** card, enter a **Label** (e.g. \`Claude Desktop\`).
3. Under **Allowed tools**, select the smallest set of tools the agent needs.
4. Click **Create token**.
5. Copy the token from the **Token (copy now — shown only once)** banner immediately — only its hash is stored.
6. Paste the token into your AI agent / MCP client configuration.
7. To list, audit, or revoke tokens later, return to this page and use the **Revoke** action.

## Fields
- **Label** — a human-readable name for the agent/integration.
- **Allowed tools** — per-tool permission scope; a call to any unselected tool is denied with \`scope_denied\`.
- **Status** — \`ACTIVE\` or \`REVOKED\`. Revoked or expired tokens are rejected at call time.
- **Last used** — timestamp of the token's most recent call, or \`never\`.

## What you'll see
- The tokens table lists each token's **Label**, tool count, **Last used**, and **Status**, with a **Revoke** button on active tokens.
- Calling a tool requires a token whose scope includes it; otherwise the call is blocked before any data is touched.
- Every tool call writes an \`MCP_CALL\` audit row recording the token id as actor, the tool, redacted arguments, and IP/user-agent.

## Tips
- Grant least privilege: issue separate tokens per integration rather than one all-tools token.
- Revoke immediately if a token leaks; revocation takes effect on the next call.
- Mutating tools (\`create_time_entry\`, \`generate_pre_bill\`, \`link_message_to_time_entry\`) audit every call, satisfying the firm's append-only audit guarantee.
`),
  },

  // =================================================================== Administration
  {
    slug: 'firm-settings',
    category: 'admin',
    title: 'Firm settings',
    summary: 'Firm-wide configuration in one place.',
    tags: ['admin', 'firm', 'settings', 'offices'],
    sortOrder: 10,
    body: md(`
# Firm settings

The **Firm** group of the admin area holds the firm-wide defaults that drive billing, approvals, branding, security, and AI. Open **Admin → Firm → Settings** (\`/admin/firm\`). The page is one long form split into cards; one **Save** button commits the whole form. Reading requires \`firm:settings:read\` (partner and above); saving requires \`firm:settings:write\`, which only the **admin** role template carries by default.

## What you'll see
- A stack of cards: **Firm**, **Engagement defaults**, **Approvals + auth + AI**, **Time entry**, **Portal**, **Branding**, **Billing and A/R**, and **Security · Unlock mode**.
- A **Save** button with a "Saved at …" confirmation timestamp.

## Fields
- **Firm**: **Default allocation method**, **Fiscal year starts in** (month), **Default invoice terms (days)**.
- **Engagement defaults**: **Enabled fee structures** (toggle pills — you cannot drop to zero), **Firm-wide billable target (hrs/month)**, **Default invoice surcharge label**.
- **Approvals + auth + AI**: **Adjustment approval threshold ($)** (default $1,000), **AI monthly budget ($)**, **AI provider preference** (Default local-first / Force local (Ollama) / Force cloud (Anthropic)), **Step-up TOTP timeout (minutes)** (default 30).
- **Time entry**: **Late-entry alert (days)**, **Late-entry lockout (days)**, **Invoice numbering prefix**. (Time-entry rounding is set per-office, not on this form — see *Taxonomy*.)
- **Portal**: **Portal enabled** checkbox, **Portal subdomain**.
- **Branding**: **Invoice template style**, **Display name**, **Logo URL**, **Accent color (hex)**, **Support email**, **Support phone**, **Support fax**, **Website**, **Footer HTML**.
- **Billing and A/R**: default invoice/statement formats for new clients, days-until-due, ACH/credit-card processing toggles, statement e-mail message, service-charge rate, dunning messages **1 Period old** through **5 Periods or older**, and **A/R Terms** (printed at the bottom of every invoice PDF).

## Steps
1. Go to **Admin → Firm → Settings**.
2. Adjust the relevant card(s).
3. Set the **Adjustment approval threshold ($)** and **AI monthly budget ($)** as dollar amounts.
4. Enter dunning text per aging bucket and your **A/R Terms** block.
5. Click **Save** and confirm the "Saved at …" timestamp.

## Tips
- Branding feeds invoice PDFs, the client portal header, and dunning emails.
- The **Security · Unlock mode** card lets an admin switch from "Sealed on disk" to "Admin passphrase" — this is one-way and irreversible; losing the passphrase makes encrypted data unrecoverable.
- The AI monthly budget warns at 80% and hard-caps at 100% of the amount you set.
`),
  },
  {
    slug: 'users-roles',
    category: 'admin',
    title: 'Users, roles & permissions',
    summary: 'How RBAC works and who can do what.',
    tags: ['rbac', 'roles', 'permissions', 'users'],
    sortOrder: 20,
    body: md(`
# Users, roles & permissions

Staff accounts live under **Admin → People**: **Users** (\`/admin/users\`), **Roles** (\`/admin/roles\`), and **Permissions** (\`/admin/permissions\`). Access is RBAC-gated — inviting a user requires \`app_user:invite\`, editing requires \`app_user:write\`, and archiving requires \`app_user:archive\` (all carried by the **admin** role template).

## What you'll see
- **Users** page: an **Invite staff** card and a **Staff** table showing Name, Email, a **TOTP** pill (enrolled / pending), **Status**, **Std hrs/wk**, and **Billable target**.
- **User detail**: tabs **Main**, **Contact Info**, **Rates**, **Skill Set**, **Targets**, **Notes**, plus **Roles**, **Authentication**, and **Lifecycle** cards.

## Steps
1. Go to **Admin → People → Users**.
2. In the **Invite staff** card, enter **Full name** and **Email**, then click **Send invite**.
3. Click a staff row to open their detail page.
4. On the **Main** tab click **Edit** to set names, hire/leave dates, **Status**, **Default office**, **Standard hours / week**, and **Billable target / month**; click **Save**.
5. In the **Roles** card, use the **+ Assign role…** picker to attach one or more roles.
6. To create a non-standard role, go to **People → Roles**, enter a **Role name**, click **Create**, then click **Permissions** to check the exact permission keys, and **Save permissions**.

## Tips — role templates (the union of all assigned roles applies)
- **admin** — full access (every permission key).
- **partner** — broad client/engagement/billing/approval rights; can read firm settings, manage rates, void invoices, refund payments, \`billing:override\`, partner-level reports.
- **manager** — write clients/engagements, build billing batches, create (not approve) adjustments; no invoice void / payment refund / partner-data reports.
- **senior** — read clients/engagements, create + edit own time, read billing batches and realization/utilization.
- **staff** — read clients/engagements, create + edit own time only.

## Other notes
- **Second factor is mandatory**: every staff user must enroll a second factor (passkey, TOTP, email OTP, or SMS OTP). The **TOTP** column shows \`pending\` until enrolled. On the **Authentication** card an admin can **Reset TOTP** — the user re-enrolls at next sign-in.
- The 5 system roles cannot be edited or deleted; the **Permissions** page is a read-only matrix of which template grants which key.
- A user with no role has read-only baseline access and will hit 403s on most actions. Use **Archive** to disable sign-in (soft delete; users are never hard-deleted).
`),
  },
  {
    slug: 'taxonomy',
    category: 'admin',
    title: 'Taxonomy: service lines, work codes, reason codes',
    summary: 'The vocabulary that organizes work and billing.',
    tags: ['taxonomy', 'service lines', 'work codes', 'reason codes'],
    sortOrder: 30,
    body: md(`
# Taxonomy: offices, work codes, service lines, reason codes, templates

Taxonomy is the reference data that scopes and prices work. It lives in two admin groups: **Firm** (offices) and **Catalog** (everything else). Most taxonomy edits require \`taxonomy:read\`/\`taxonomy:write\`; offices use \`office:read\`/\`office:write\`.

## What you'll see
- **Taxonomy** page (\`/admin/taxonomy\`) stacks three cards: **Service lines**, **Work codes**, **Reason codes**.
- **Offices** (\`/admin/offices\`) under the Firm group.
- **Engagement statuses**, **Templates**, and **Recurring engagements** under the Catalog group.

## Fields
- **Service lines**: **Name** + **Category** (Tax, Audit, Advisory, Bookkeeping, Payroll). Rename via the row's **Rename** button.
- **Work codes**: **key** (snake_case) + **Display name**, with a **Billable default** column. Work codes drive in-scope tagging on engagements and can be attached to staff under a user's **Skill Set** tab.
- **Reason codes**: **Category** (Write-down, Write-up, Transfer) + **Label**. Used when staff record write-ups/write-downs and transfers.
- **Offices**: **Name** + **Timezone**; one office is flagged \`default\`. Each office has a **Settings** panel with per-office overrides.

## Steps
1. **Add a service line**: Admin → Catalog → Taxonomy → **Service lines** card → type **Name**, pick **Category**, click **Add**.
2. **Add a work code**: in the **Work codes** card, enter **key (snake_case)** and **Display name**, click **Add**.
3. **Add a reason code**: in the **Reason codes** card, pick **Category**, type **Label**, click **Add**.
4. **Add an office**: Admin → Firm → Offices → **Add office** card → **Name** + **Timezone** → **Add**.
5. **Override an office setting**: click **Settings** on an office row, then set any of **Adjustment approval threshold (cents)**, **Time entry rounding (hours)**, **Late-entry alert days**, **Late-entry lockout days**, **Invoice numbering prefix**. Leave blank to inherit the firm value; the "Effective" line shows the resolved value.

## Tips
- **Office overrides** are where per-office time-entry rounding lives — blank means "inherit firm default". Use **Clear** to drop an override.
- **Engagement statuses** (\`/admin/engagement-statuses\`) lets you relabel/recolor and set kanban visibility for each workflow state; the underlying state set is fixed.
- **Templates** (\`/admin/templates\`) holds engagement, letter, client, and request templates — carrying default fee, budget hours, work codes, and name patterns.
- Taxonomy rows are renamed in place, not deleted, to keep historical references intact.
`),
  },
  {
    slug: 'admin-misc',
    category: 'admin',
    title: 'Holidays, required fields & other settings',
    summary: 'Smaller admin controls worth knowing.',
    tags: ['admin', 'holidays', 'required fields'],
    sortOrder: 40,
    body: md(`
# The admin area at a glance

The admin sidebar collapses into seven semantic groups; each expands to a list of tabs. The landing route \`/admin\` redirects to **Firm → Settings**. This is a map of what each tab does so you can find things fast.

## What you'll see
- **Firm**: **Settings** (firm-wide defaults), **Offices** (locations + per-office overrides), **Holidays** (firm holidays + PTO).
- **People**: **Users** (invite + staff list), **Roles** (system + custom roles), **Permissions** (read-only permission matrix).
- **Catalog**: **Taxonomy**, **Engagement statuses**, **Templates**, **Recurring engagements**, **Services catalog**, **Packages**, **Payment methods**, **Tax payments**, **Terms templates**, **Milestones**, **Engagement letters**.
- **Billing**: **Rate codes**, **Rates**, **Recurring plans**, **Hour banks**, **Hour-bank tx**, **Retainer tiers**, **Appointments**, **Approval rules**, **Required fields**, **Stripe Connect**.
- **Messaging**: **Email + SMS providers**, **Notification templates**, **Notifications log**, **Webhooks**.
- **AI & Integrations**: **AI usage**, **API tokens**, **Saved reports**.
- **Operations**: **Jobs**, **Data**, **Backup**, **Compliance**, **Storage settings**, **Storage onboarding**, **Storage conflicts**, **Cloudflare Tunnel**.
- **Support**: **Knowledge Base**.

## Tips — key Operations & Integrations tabs
- **Jobs** (\`/admin/jobs\`): lists scheduled worker jobs (recurring-billing, ar-aging-snapshot, dunning-sweep, late-fee-accrual, late-entry-alert, milestone-date-trigger, hour-bank-expiration, approval-escalation, view-refresh) with queue stats and a **Run now** button.
- **Notifications log** (\`/admin/notifications\`): outbound dunning/invoice/payment deliveries — one row per attempt, with **Sent**, **Invoice**, **Step**, **Channel**, **Recipient**, **Outcome**, and error text; filter by window.
- **AI usage** (\`/admin/ai-usage\`): **AI status**, a usage summary (Requests, Failed, tokens, Cost) over a 7/30/90/180-day window, a per-feature filter, a request log, and a pricing-suggestions card.
- **API tokens** (\`/admin/api-tokens\`): create MCP/REST tokens for AI agents and integrators (Label + Allowed tools); the plaintext is shown once. **Revoke** disables a token.
- **Data** (\`/admin/data\`): **Load demo dataset** seeds a sample firm; **Reset to blank** wipes operational data (type \`delete everything\` to enable). Both need \`firm:settings:write\` and a fresh step-up.
- **Backup** (\`/admin/backup\`): backups run via nightly cron to \`/backups\` (30-day retention); restore via \`ops/docs/restore.md\`.
- **Compliance** (\`/admin/compliance\`): a firm snapshot of record counts and a downloadable WISP starter template.
- **Storage settings / onboarding / conflicts**: configure the file-storage backend (B2 / MinIO), match client folders, and resolve reconciliation conflicts.

## Steps
1. Click a group header in the left admin nav to expand or collapse it (your state is remembered per browser).
2. Click a tab to open that page.
3. Use **Firm → Settings** as your starting point — \`/admin\` redirects there.
`),
  },

  // =================================================================== Security
  {
    slug: 'security-model',
    category: 'security',
    title: 'Security model overview',
    summary: 'Realms, encryption, and non-negotiables.',
    tags: ['security', 'encryption', 'isolation'],
    sortOrder: 10,
    body: md(`
# Security model

Vibe Practice Management is a self-hosted appliance, so the firm holds all of its own data. The security model is built around several layers that work together: envelope encryption for sensitive content, strong password and token hashing, strict separation between the staff app and the client portal, CSRF protection on every mutating request, an append-only audit log, and role-based access control.

## What you'll see
- **Envelope encryption.** Each firm has one 32-byte Master Firm Key (MFK). The MFK never wraps content directly; it wraps smaller data-encryption keys (DEKs). A secure message thread has its own per-thread DEK, used to encrypt messages and stored wrapped by the MFK. Stored secrets (storage credentials, Cloudflare tunnel tokens) are wrapped the same way. Decryption unwraps the DEK in memory, decrypts, then zeroes the plaintext key.
- **Authenticated encryption.** Every encrypted blob uses XChaCha20-Poly1305 with a random 24-byte nonce; tampered or wrong-key data fails closed.
- **Argon2id passwords.** Staff passwords are stored as argon2id digests, never plaintext (minimum 12 characters). Magic-link sign-in remains available alongside passwords.
- **Token hashing at rest.** Session, magic-link, and OTP tokens are hashed with SHA-256. API/MCP tokens are hashed with SHA-256 and looked up by hash — the raw token is shown once and never stored.
- **Cross-realm session isolation.** The staff app and portal use distinct cookie names and distinct JWT signing keys; the API refuses to start if the two secrets match. A staff session is never valid in the portal and vice versa.
- **CSRF protection.** Session cookies are \`HttpOnly\`, \`SameSite=Strict\`, and \`Secure\` over HTTPS. Mutating requests must also carry a matching \`x-csrf-token\` header (double-submit), compared in constant time.
- **Second factor for staff.** Every staff user has at least one second factor (passkey, TOTP, email OTP, or SMS OTP), challenged after both magic-link and password sign-in. Recovery codes are generated when TOTP is enrolled and shown once.
- **Step-up re-verification.** Sensitive actions require a fresh step-up within the last 30 minutes; higher-risk money actions re-prompt on the spot.
- **Append-only audit log.** Every mutation writes an \`audit_log\` row, and the database role cannot UPDATE or DELETE those rows.
- **RBAC.** Access is gated by permission keys; the admin role holds every permission, other roles a subset.

## Tips
- Treat the MFK passphrase (in admin-passphrase mode) as your single most important secret — there is no recovery if it's lost.
- Brute-force protection is layered: failed step-up/TOTP attempts are rate-limited in Redis, and unlock attempts are rate-limited by IP.
- Security response headers (HSTS, \`X-Frame-Options: DENY\`, \`X-Content-Type-Options: nosniff\`, a strict CSP, and a Permissions-Policy) are sent on both surfaces.
`),
  },
  {
    slug: 'appliance-unlock',
    category: 'security',
    title: 'Appliance unlock & the firm key',
    summary: 'Sealed-on-disk vs admin-passphrase unlock.',
    tags: ['security', 'unlock', 'passphrase', 'firm key', 'crypto'],
    sortOrder: 20,
    body: md(`
# Unlocking the appliance

All of a firm's sensitive content — secure message threads and stored secrets such as storage credentials and Cloudflare tunnel tokens — is encrypted with the firm's Master Firm Key (MFK). The MFK is never stored in the clear; it's held wrapped in the database and only unwrapped into process memory when the appliance is "unlocked." Until then, encrypted data cannot be read.

## Fields
- **Unlock mode.** Either **Sealed on disk** (default) or **Admin passphrase**, shown in admin under **Security · Unlock mode**.
- **Sealed on disk.** A key-encryption key (KEK) is stored on the appliance volume (default path \`/data/.firm-key.seal\`, restrictive permissions). At boot the API reads it and unseals the MFK automatically — no operator action.
- **Admin passphrase.** The KEK is derived from an operator passphrase via Argon2id. The MFK can only be unwrapped when someone enters the passphrase; nothing on disk alone can unlock the appliance.

## Steps
1. Boot the appliance. On every API start it reads \`unlock_mode\` and either auto-unseals (sealed-on-disk) or stays locked (admin-passphrase).
2. In admin-passphrase mode, check status with \`GET /api/staff/admin/unlock/status\`. A locked appliance reports \`locked: true\`.
3. Unlock with \`POST /api/staff/admin/unlock\` and body \`{ "passphrase": "..." }\`. The first call (no envelope yet) bootstraps the envelope; later calls unseal the existing one.
4. On success the appliance serves normal traffic.
5. To relock manually, an operator with the \`crypto:unlock\` permission sends \`POST /api/staff/admin/unlock/lock\` — this forgets the in-memory MFK.

## What you'll see
- **While locked**, every route except a small allowlist returns HTTP 503 \`appliance_locked\`. The allowlist covers health probes, \`/metrics\`, the unlock surface, and \`/api/auth\`.
- **Wrong passphrase** returns HTTP 401 \`unlock_failed\` (a sentinel is verified after unwrap; a wrong passphrase never yields a usable key).
- **Rate limiting.** Unlock attempts are limited per IP (3 per 5 minutes; exceeding triggers a 15-minute backoff with HTTP 429 \`rate_limited\`).

## Tips
- Migrate from **Sealed on disk** to **Admin passphrase** in admin under **Security · Unlock mode** → **Switch to admin-passphrase** (passphrase ≥12 chars + acknowledgement). This is **one-way** and requires \`crypto:rotate\`.
- In admin-passphrase mode the operator must enter the passphrase at every boot. If it's lost, encrypted firm data is unrecoverable — store it safely.
- Sealed-on-disk is convenient for unattended reboots but offers less protection if the disk itself is compromised, since the KEK lives beside the data.
`),
  },
  {
    slug: 'audit-log',
    category: 'security',
    title: 'The audit trail',
    summary: 'Who did what, immutably recorded.',
    tags: ['audit', 'log', 'compliance'],
    sortOrder: 30,
    body: md(`
# The audit log

Every state-changing action writes a row to the \`audit_log\` table — client and engagement edits, sign-ins and sign-outs, step-ups, exports, payments, webhook deliveries, MCP calls, AI requests, backups, and database restores. The log is append-only at the database level: rows can be added but never altered or removed.

## Fields
Each audit row records:
- **occurredAt** — timestamp of the event.
- **action** — one of \`CREATE\`, \`UPDATE\`, \`ARCHIVE\`, \`RESTORE\`, \`LOGIN\`, \`LOGOUT\`, \`STEP_UP\`, \`EXPORT\`, \`IMPERSONATE\`, \`PAYMENT\`, \`WEBHOOK_DELIVERY\`, \`MCP_CALL\`, \`AI_REQUEST\`, \`BACKUP\`, \`RESTORE_DATABASE\`.
- **entityType / entityId** — what was acted on.
- **actor** — exactly one of \`actorAppUserId\` (staff), \`actorPortalIdentityId\` (portal client), or \`actorMcpTokenId\` (API/MCP token); system events may have none. The "at most one actor" rule is enforced by a database check constraint.
- **beforeJson / afterJson** — the before and after state.
- **ip / userAgent / requestId** — request source and correlation id.

## Steps
1. Open **Audit** in the staff app sidebar (requires \`admin:audit:read\`).
2. Use the **Filter audit log** card to narrow by **Entity type**, **Entity ID**, **Start**, and **End**, then **Apply**. Filters persist across reloads.
3. To search action / entity type / entity id / IP / user-agent text, use **Full-text search**: type at least two characters into **Search audit text** and click **Search**.
4. To export, request \`/api/staff/audit/export.csv\` (with your active filters). This requires the separate \`admin:audit:export\` permission.

## What you'll see
- The **Events** table lists each row with **When**, **Action** (a pill), **Entity**, a shortened **Entity ID**, **Actor** (a \`staff\` or \`portal\` pill plus a shortened id), and **IP**. Newest first; the list view returns up to 200 rows.
- Specialized read-only views exist for events by IP, by actor, by entity, recent webhook deliveries, recent outbound notifications, and worker alerts.

## Tips
- The log cannot be edited or deleted by the application — the app DB role has only INSERT and SELECT on \`audit_log\`; UPDATE/DELETE/TRUNCATE are revoked, with triggers as a backstop.
- Retention purges (if your firm runs them) must use a privileged maintenance role, never the running app.
- Use **Entity ID** filtering to reconstruct one record's full history, or actor filtering to review one user's activity.
`),
  },

  // =================================================================== Deployment & Operations
  {
    slug: 'deployment-modes',
    category: 'deployment',
    title: 'Deployment modes',
    summary: 'Domain, LAN, and Tailscale-only access.',
    tags: ['deployment', 'domain', 'lan', 'tailscale'],
    sortOrder: 10,
    body: md(`
# Deployment modes & access

Vibe Practice Management runs as a self-hosted Docker appliance: an API container, a worker, Caddy as the ingress, and (in production) bundled Postgres, Redis, a nightly backup container, and a Cloudflare Tunnel sidecar. Caddy serves the staff app and client portal as static SPAs and reverse-proxies \`/api/*\` to the API on port \`3001\`. How you reach the two apps depends on which compose file and hostnames you use.

## Steps
1. Build and start the local appliance: \`docker build -t vibe-time-billing:local .\` then \`docker compose -f ops/docker/docker-compose.local.yml up -d\`. This starts \`init-static\` (copies the bundled web + portal dists into a shared volume), \`api\`, \`worker\`, and \`caddy\`.
2. Reach the apps over HTTPS on the published Caddy ports: staff at \`https://<VIBE_HOST>:5195\`, portal at \`https://<VIBE_HOST>:5196\`. The API is also exposed at \`http://localhost:3001\` for debugging.
3. For LAN access from other machines, set \`VIBE_HOST=<lan-ip>\` before \`up\`. Caddy binds its TLS sites to that host and uses it as \`default_sni\` so handshakes to a bare IP succeed.
4. Accept the one-time browser warning for Caddy's internal-CA cert (\`tls internal\`), or import Caddy's root CA. HTTPS is required because the session cookie is \`Secure\` — over plain HTTP off-localhost the browser drops it and login loops.
5. In production, deploy with \`ops/docker/docker-compose.prod.yml\` (image \`ghcr.io/kisaesdevlab/vibe-time-billing:\${TAG:-latest}\`), which publishes Caddy on \`80\`/\`443\` and host-routes \`app.<domain>\` to staff and \`portal.<domain>\` to the portal.

## Fields
- \`VIBE_HOST\` — host the local Caddy TLS sites bind to; defaults to \`localhost\`. Set to your LAN IP for off-box HTTPS.
- \`APP_BASE_URL\` / \`PORTAL_BASE_URL\` — staff and portal base URLs used in links/emails (local defaults \`http://localhost:5195\` / \`:5196\`).
- \`STAFF_JWT_SECRET\` / \`PORTAL_JWT_SECRET\` — distinct signing secrets per realm; required.
- \`KMS_KEY\` — 32-byte base64 envelope-encryption master key; required (API exits at boot if missing).
- \`COMMERCIAL_LICENSE_TOKEN\` — enables the client portal; absent means portal disabled.

## What you'll see
- Staff requests get \`X-Vibe-Realm: app\`; portal requests get \`X-Vibe-Realm: portal\`. The API uses this plus distinct cookies to keep realms isolated.
- On local, both apps live on the same host but different ports (\`5195\`/\`5196\`) because one \`localhost\` can't disambiguate by Host header.
- In production both realms share \`80\`/\`443\` and split by hostname: \`portal.*\` matches the portal block, everything else (including direct IP) gets the staff realm.

## Tips
- The local compose joins the external \`docker_default\` network so DNS names \`postgres\` and \`redis\` resolve.
- Re-running \`up\` re-runs \`init-static\`, so a fresh image rebuild propagates to the static volume.
- The sealed firm key persists on a named volume — keep that volume to avoid re-bootstrapping the master key and orphaning encrypted data.
`),
  },
  {
    slug: 'remote-access-cloudflare',
    category: 'deployment',
    title: 'Remote access with Cloudflare Tunnel',
    summary: 'Publish on your domain with no open ports.',
    tags: ['cloudflare', 'tunnel', 'remote', 'dns', 'https'],
    sortOrder: 20,
    body: md(`
# Remote access via Cloudflare Tunnel

For public access without opening firewall ports, the appliance ships a bundled \`cloudflared\` sidecar and an in-admin wizard that provisions a Cloudflare Tunnel for you. You paste a Cloudflare API token, the appliance creates the tunnel, writes DNS CNAMEs, sets ingress, and drops a run-token for the sidecar to consume. The sidecar dials out to Cloudflare's edge — no inbound rules required. You keep ownership of the Cloudflare account; the token is stored encrypted with the firm key. The wizard lives at **Admin → Operations → Cloudflare Tunnel** and gates on \`firm:settings:write\`.

## Steps
1. Create a Cloudflare API token with \`Account:Cloudflare Tunnel:Edit\` and \`Zone:DNS:Edit\` permissions.
2. Go to **Admin → Operations → Cloudflare Tunnel**. Under **Step 1**, paste the token into **API token** and click **Connect**. This validates the token and loads your accounts and zones.
3. Under **Step 2**, choose the **Account** and **Domain** from the dropdowns.
4. Under **Step 3**, add the hostnames to publish. Each row is a subdomain label plus a realm selector (**Staff** or **Portal**). Defaults are \`app\` → Staff and \`portal\` → Portal. Use **+ Add hostname** to add more.
5. Click **Provision tunnel**. The appliance creates the tunnel, sets ingress, writes CNAMEs to \`<tunnel-id>.cfargotunnel.com\`, encrypts both tokens, and writes the run-token to the sidecar volume.
6. To change hostnames later, click **Edit hostnames**, adjust the rows, and **Save changes** — this reconciles DNS and ingress in place without recreating the tunnel (the sidecar keeps running).

## Fields
- **API token** — entered as a password field; only the last 4 chars are retained as a hint.
- **Account** / **Domain** — chosen from discovered dropdowns.
- **Hostnames** — list of subdomain + realm. Staff hostnames route to the staff app; Portal hostnames to the client portal.

## What you'll see
- A status pill: \`INACTIVE\`, \`PROVISIONING\`, \`ACTIVE\`, or \`ERROR\`.
- When the sidecar is connected, a "N connector(s)" pill; when it isn't, a "sidecar offline" pill. A worker polls the sidecar's metrics endpoint once per minute and stores a snapshot, including edge region.
- Each hostname is listed with a Staff/Portal pill and its \`https://<hostname>\` URL.
- On failure the row goes to \`ERROR\` and a **Last error** box shows the Cloudflare message; the wizard re-opens as **Re-provision**.

## Tips
- Portal hostnames are saved but get no ingress/DNS until a commercial license token is active — re-provision picks them up once licensed.
- The tunnel ingress rewrites the origin Host header to \`app.<zone>\` / \`portal.<zone>\` so Caddy routes correctly regardless of the public label — no Caddyfile edits.
- **Disable** deletes the tunnel and its DNS records, clears the stored tokens, removes the token file, and sets status \`INACTIVE\` — traffic stops until you re-provision.
- On the local compose, the sidecar reads \`TUNNEL_TOKEN\` and only runs once a token file exists.
`),
  },
  {
    slug: 'backups',
    category: 'deployment',
    title: 'Backups and restore',
    summary: 'Nightly database backups and recovery.',
    tags: ['backup', 'restore', 'pg_dump', 'data'],
    sortOrder: 30,
    body: md(`
# Backups & restore

The appliance takes a nightly \`pg_dump\` of the Postgres database to the \`/backups\` volume and keeps 30 days by default. In production this runs from a dedicated \`backup\` container that installs cron and runs \`ops/scripts/backup.sh\` at 02:00 daily. Restore is a deliberate, documented procedure (\`ops/docs/restore.md\`) with a helper script (\`ops/scripts/restore.sh\`). Because backups are nightly, **up to 24 hours of data can be lost** between the last backup and a failure — there is no point-in-time recovery in v1.

## Steps
1. Backups run automatically — the crontab \`0 2 * * * /scripts/backup.sh\` produces \`/backups/vibe-tb-YYYY-MM-DD.sql.gz\`.
2. To restore, first stop the app: \`docker compose -f ops/docker/docker-compose.prod.yml stop api worker\`.
3. Identify the backup — files are named \`vibe-tb-YYYY-MM-DD.sql.gz\` in \`/backups\`. Pick the most recent one before the problem.
4. Run the restore helper with \`DATABASE_URL\` set: \`./restore.sh --latest\` (or pass a path). It verifies gzip integrity, snapshots the current DB, drops and recreates the database, restores, refreshes materialized views, and runs sanity checks.
5. Confirm at the prompts: answer \`yes\` to "Have you stopped the api and worker containers?" and type \`RESTORE\` to proceed.
6. After restore: flush Redis (\`docker exec vibe-tb-redis redis-cli FLUSHDB\`), restart with \`docker compose up -d api worker\`, and verify \`curl -fsS http://localhost:3001/health\`.

## Fields
- \`BACKUP_DIR\` — backup target; defaults to \`/backups\`.
- \`BACKUP_RETENTION_DAYS\` — retention window; defaults to \`30\`. Older dumps are pruned each run.
- \`DATABASE_URL\` — required by both \`backup.sh\` and \`restore.sh\`.
- \`BACKUP_SUCCESS_WEBHOOK\` / \`BACKUP_FAILURE_WEBHOOK\` — optional URLs posted to on success/failure.

## What you'll see
- \`backup.sh\` logs to \`/backups/backup.log\`, runs \`pg_dump\` piped through \`gzip --best\`, then checks the file is over 1 KB and passes \`gunzip -t\`.
- \`restore.sh\` prints a warning banner with the file, size, and target DB; captures a pre-restore snapshot; restores; then prints row counts for key tables and verifies adjustment-allocation sums.
- After restore it warns that records created after the backup's timestamp are not recovered.

## Tips
- Run the monthly restore-verification drill in \`ops/docs/restore.md\`: restore the latest backup into a throwaway Postgres container and check a row count.
- Mirror \`/backups\` off-appliance so a hardware loss doesn't take the backups with it.
- The restore script does NOT stop containers or flush Redis for you — do those manually per the procedure.
- Post-restore, reconcile any Stripe payments whose webhooks landed during the gap.
`),
  },
  {
    slug: 'upgrades',
    category: 'deployment',
    title: 'Upgrades',
    summary: 'How new versions roll out.',
    tags: ['upgrade', 'version', 'migration'],
    sortOrder: 40,
    body: md(`
# Upgrades & migrations

Vibe Practice Management ships as a versioned Docker image. Database migrations run automatically at API boot, so a normal upgrade is "pull the new image and restart." Migrations are tracked and idempotent — re-running the migrator skips already-applied files. There is no automated down-migration: rollback always means restoring a backup taken before the upgrade.

## Steps
1. Take an on-demand backup before upgrading (in addition to the nightly job). See *Backups & restore*.
2. Pull the new image: \`docker compose -f ops/docker/docker-compose.prod.yml pull\` (controlled by the \`TAG\` env var, default \`latest\`).
3. Recreate the stack: \`docker compose -f ops/docker/docker-compose.prod.yml up -d\`. The \`api\` container's entrypoint applies migrations first, then starts the server; \`init-static\` re-copies the new dists so Caddy serves the new build.
4. Watch the API logs for the "applying migrations…" then "migrations done. starting server." lines.
5. Verify health: \`/health\` should return 200 within the Docker healthcheck window.

## Fields
- \`TAG\` — image tag to deploy; defaults to \`latest\`.
- \`DATABASE_URL\` — target the migrator runs against; required.
- \`LOG_LEVEL\` — set to \`debug\` for verbose migration output.

## What you'll see
- The migration runner creates a \`schema_migrations\` table (\`filename\`, \`applied_at\`), then applies any \`packages/db/migrations/NNNN_name.sql\` file not yet recorded, in lexical order. Already-applied files log \`skip\`; new ones log \`apply\`.
- Migrations are numbered SQL files (\`0000_init_schema.sql\` onward) and currently run to the high 0090s.

## Tips
- Migrations run on every boot but are safe to re-run — the \`schema_migrations\` ledger prevents double-application.
- Zero-data-loss note: the worker waits for the API to be healthy, and the API only serves after migrations complete, so requests never hit a half-migrated schema.
- Rollback: stop the stack, restore the pre-upgrade backup, re-pull the previous \`TAG\`, and bring it back up. SQL migrations are not reversed.
- After upgrading, spot-check worker jobs and that dashboard totals match the pre-upgrade baseline.
`),
  },

  // =================================================================== Integrations & API
  {
    slug: 'integrations-overview',
    category: 'integrations',
    title: 'Integrations overview',
    summary: 'Payments, email/SMS, Cloudflare, Shield, and Connect.',
    tags: ['integrations', 'providers', 'connect'],
    sortOrder: 10,
    body: md(`
# Integrations overview

Vibe Practice Management connects to a handful of external services so the appliance can take card payments, send email and SMS, store files, reach the internet, and run cloud AI. The guiding rule everywhere: **you supply your own credentials**. Kisaes never holds your Stripe keys, mail-provider secrets, Cloudflare token, or AI keys — they live on your appliance (as env vars) or encrypted at rest in your own database.

## Steps
1. **Payments (Stripe).** Stripe keys are set on the appliance as environment variables — \`STRIPE_SECRET_KEY\`, \`STRIPE_PUBLISHABLE_KEY\`, \`STRIPE_WEBHOOK_SECRET\` — using your own Stripe account. When \`STRIPE_SECRET_KEY\` is present, online card payment turns on and the staff **Receive Payment** form shows the Card (Stripe) option.
2. **Payments (CPACharge).** CPACharge is scaffolded but **not yet live** — the provider stub returns not-implemented and there's no admin screen to enable it today.
3. **Stripe Connect (optional).** A separate **Admin → Billing → Stripe Connect** page supports the operator-platform OAuth flow; it only appears configured when the operator has set the Connect env vars. The firm then clicks **Connect Stripe** to link its own account.
4. **Email provider.** Go to **Admin → Messaging → Email + SMS providers**. In the **Email provider** card, pick \`SMTP\`, \`Postmark\`, \`Resend\`, or \`AWS SES\`, fill the credentials, click **Send test**, then **Save**.
5. **SMS provider.** In the same screen's **SMS provider** card, pick \`TextLink\`, \`Twilio\`, or \`AWS SNS\`, enter credentials, **Send test** to an E.164 number, then **Save**.
6. **Object storage.** Configure your bucket under **Admin → Operations → Storage settings** / **Storage onboarding** (Backblaze B2 or MinIO/S3-compatible). See the storage articles.
7. **Cloudflare Tunnel.** Under **Admin → Operations → Cloudflare Tunnel**, paste an API token and provision hostnames. See *Remote access via Cloudflare Tunnel*.
8. **Cloud AI providers.** Cloud AI is set via env vars (\`AI_CLOUD_API_KEY\` for Anthropic, or the OpenAI-compatible vars); local AI uses Ollama. Cloud egress is additionally gated by the Vibe Shield policy.

## Fields
- **Stripe** — your account's secret/publishable/webhook keys, set on the appliance (not in the UI).
- **Email** — **From address** plus provider secrets (SMTP host/port/user/password, Postmark **Server token**, Resend **API key**, or SES **Region** + **Access key ID** + **Secret access key**).
- **SMS** — TextLink **API key**; Twilio **From number (E.164)** + **Account SID** + **Auth token**; or SNS **Region** + keys.
- **Cloudflare — API token** — scoped for Tunnel + DNS edit.

## What you'll see
- The Email and SMS cards show a status pill: green "**<provider>** configured" when saved credentials exist, or neutral "Using env defaults" when none are saved (the dispatcher falls back to env vars).
- Saved messaging credentials are **encrypted at rest** and never returned in plaintext — reads show masked previews; editing requires re-entering the secret.
- **Clear** on a provider card removes the saved config and restores env-var defaults.

## Tips
- Use **Send test** before **Save** so you confirm connectivity without breaking live notifications.
- Rotating Stripe keys is a config change on the appliance — the publishable key is served at runtime, so no web rebuild is needed.
- Everything here is customer-owned: revoking a key at the provider immediately cuts the appliance's access.
- For programmatic access and outbound events, see *API access & webhooks*.
`),
  },
  {
    slug: 'rest-api-webhooks',
    category: 'integrations',
    title: 'REST API & webhooks',
    summary: 'Programmatic access and outbound events.',
    tags: ['api', 'rest', 'webhooks', 'tokens', 'integration'],
    sortOrder: 20,
    body: md(`
# API access & webhooks

The appliance offers three programmatic surfaces: a token-authenticated **REST API v1** for integrators, the **MCP server** for AI agents, and **outbound webhooks** that push events to your own endpoints. The REST API and MCP share one token type and the same per-tool scoping. Inbound payment confirmation also flows through a webhook — the Stripe webhook is the source of truth that marks invoices paid.

## Steps
1. **Issue a token.** Open **Admin → AI & Integrations → API tokens**. In the **Create MCP token (Q13)** card, enter a **Label**, select the **Allowed tools**, and click **Create token**.
2. **Copy it once.** The plaintext appears in the **Token (copy now — shown only once)** banner; only its SHA-256 hash is stored. Paste it into your client.
3. **Call the REST API.** Send requests to \`/api/v1/...\` with header \`Authorization: Bearer <token>\`. Available endpoints: \`GET /v1/engagements\`, \`GET /v1/time-entries\`, \`POST /v1/time-entries\`, and \`GET /v1/invoices\`. Each route requires the matching tool scope.
4. **Or connect an AI agent.** Point an MCP client at the MCP server using the same token — see *MCP server for AI agents*.
5. **Register a webhook endpoint.** Open **Admin → Messaging → Webhooks**, enter an **HTTPS URL**, tick the **Events** you want, and click **Create**.
6. **Save the signing secret.** The **Secret (copy now — shown only once)** banner appears — store it to verify deliveries.
7. **Verify it works.** Use **Test** to fire a sample delivery, then **Deliveries** to inspect attempts. **Rotate** issues a new secret; **Archive** stops further events.

## Fields
- **Label** — name for the API/MCP token.
- **Allowed tools** — per-tool scope; a call to an unselected tool returns \`403 scope_denied\`.
- **HTTPS URL** — webhook receiver; must start with \`https://\`.
- **Events** — outbound event types: \`invoice.sent\`, \`invoice.paid\`, \`invoice.overdue\`, \`payment.received\`, \`payment.failed\`, \`engagement.created\`, \`engagement.closed\`, \`adjustment.applied\`, \`pre_bill.generated\`, \`client.created\`, \`client.unlocked\`, \`recurring_plan.invoice_generated\`.

## What you'll see
- **Inbound Stripe webhook is the source of truth.** Mounted at \`/api/webhooks/stripe\`, it verifies the Stripe signature against your \`STRIPE_WEBHOOK_SECRET\`, then on a succeeded charge marks payments **SUCCEEDED**, updates the invoice to **PARTIALLY_PAID** or **PAID**, and triggers confirmation email, deliverable unlock, and retainer activation. It's idempotent, so re-deliveries are no-ops.
- **Outbound deliveries are signed.** Each POST carries \`x-vibe-event\`, \`x-vibe-timestamp\`, \`x-vibe-delivery-id\`, and \`x-vibe-signature\` (HMAC-SHA256 over \`timestamp.body\` using your endpoint secret). Verify the signature on receipt.
- **Retries.** A non-2xx response is retried with exponential backoff up to 6 attempts before the delivery is marked \`FAILED\`. The Deliveries table shows status, attempt count, and last HTTP status.
- **REST tokens are rate-limited** to 60 requests/minute/token by default, returning \`429\` with \`Retry-After\`.

## Tips
- Grant least privilege — issue a separate token per integration and **Revoke** immediately if one leaks.
- REST mutations (e.g. \`POST /v1/time-entries\`) write an audit row with the **token id** as the actor, just like MCP calls.
- An unrecognized incoming Stripe charge (e.g. created from the Stripe dashboard) is skipped and surfaced in the firm's reconciliation report rather than auto-applied.
- A CPACharge webhook route exists at \`/api/webhooks/cpacharge\` but is a stub today.
`),
  },

  // =================================================================== Troubleshooting
  {
    slug: 'login-loops',
    category: 'troubleshooting',
    title: "I can't sign in / it returns to the sign-in screen",
    summary: 'Wrong account, missing 2FA, HTTP vs HTTPS, or no role.',
    tags: ['troubleshooting', 'login', '403', 'cookie'],
    sortOrder: 10,
    body: md(`
# Login keeps returning to the sign-in page

You enter your email (or password + code), the page reloads, and you land back on the sign-in screen as if nothing happened. In almost every case this is a cookie problem, not a password problem: the browser is refusing to keep the session cookie the server set.

## Symptoms
- After a successful sign-in the app immediately bounces back to the login page.
- You can request a magic link or sign-in code and it works, but the dashboard never "sticks."
- The loop happens on a specific URL (often a bare LAN IP or an \`http://\` address) but not on others.
- Other staff on the same network hit the same loop on the same URL.

## Causes & fixes
1. **You are using \`http://\` instead of \`https://\` (most common).** The staff session cookie (\`__vibe_app_session\`) is \`Secure\` whenever \`APP_BASE_URL\` starts with \`https://\`, and \`SameSite=Strict\`. A \`Secure\` cookie is silently dropped over plain \`http://\`, so the next request arrives with no session. Fix: open the app over its HTTPS URL — on a LAN appliance that's \`https://<host>:5195\` served by Caddy with \`tls internal\`. Accept or import the Caddy local-CA certificate once.
2. **\`APP_BASE_URL\` doesn't match how you reach the app.** The \`Secure\` flag is decided from \`APP_BASE_URL\`, not the incoming request. Fix (operator): set \`APP_BASE_URL\` to the exact scheme + host + port users type, then restart the API.
3. **Bare IP over HTTPS and the handshake fails.** TLS clients hitting a bare IP send no SNI. The local Caddyfile sets \`default_sni {$VIBE_HOST:localhost}\`. Fix (operator): set \`VIBE_HOST\` to the appliance IP/hostname so the cert and default_sni match.
4. **Wrong realm / cookie.** Staff and portal are fully separate (\`__vibe_app_session\` vs \`__vibe_portal_session\`). Fix: use the staff URL for staff and the portal URL for clients; don't reuse one tab across both.
5. **Signed in but everything is forbidden (403).** Your user has no role. Fix: ask an admin to assign one in **Admin → People**.
6. **Cookies blocked or cleared.** Privacy extensions or aggressive cookie clearing can drop the session. Fix: allow cookies for the app host and retry.

## Tips
- Fastest test: if the address bar shows \`http://\`, switch to \`https://\` and sign in again.
- Sessions last 7 days; constant re-prompts even over HTTPS suggest clock skew or a cookie-clearing extension.
- Operators: after changing \`APP_BASE_URL\` or \`VIBE_HOST\`, restart the API and Caddy.
`),
  },
  {
    slug: 'email-not-arriving',
    category: 'troubleshooting',
    title: 'Emails or codes are not arriving',
    summary: 'Check the mail provider configuration.',
    tags: ['troubleshooting', 'email', 'smtp', 'otp'],
    sortOrder: 20,
    body: md(`
# Sign-in code or email isn't arriving

You requested a magic link, a sign-in code, or a client notification, and nothing showed up. Because the app is deliberately privacy-preserving about whether an account exists, a "sent" message on screen does not guarantee an email actually went out. Start by confirming what the server actually did.

## Symptoms
- You ask for a magic link / sign-in code and see "If your account exists, a sign-in code has been sent," but no email arrives.
- Password sign-in returns \`email_dispatcher_unavailable\` or \`sms_dispatcher_unavailable\` when you pick the email/SMS factor.
- Client-facing notifications (invoices, dunning, receipts) never reach clients.
- Emails work in development but not after deploying the appliance.

## Causes & fixes
1. **Enumeration-safe response is hiding a non-existent account.** The login endpoint always returns the same generic message whether or not the email matches a user. Fix: confirm the address exactly matches the staff/client record (an operator can verify the user exists in Admin).
2. **No real mail provider configured (operator).** The server picks a provider from \`MAIL_PROVIDER\` (\`smtp\` / \`postmark\` / \`resend\` / \`ses\`). For postmark/resend, if the matching secret is missing the app silently falls back to a console provider that only logs to stdout — nothing is emailed; \`ses\` is not yet wired. Fix: set \`MAIL_PROVIDER\`, \`MAIL_FROM\`, and the provider's credentials, then restart the API.
3. **You're in dev pointing at MailHog.** The default dev config is SMTP to MailHog (\`localhost:1025\`, web inbox at \`http://localhost:8025\`). Mail won't reach real inboxes — check the MailHog UI; for real delivery switch \`MAIL_PROVIDER\` to a live provider.
4. **The provider accepted it but delivery failed.** Every send appends a \`notification_log\` row with status \`sent\` or \`failed\`. Fix: check **Admin → Notifications → Outbound notifications**. A \`failed\` row's error points at bad credentials, a rejected \`from\` address, or throttling; a \`sent\` row means the problem is downstream (spam folder, recipient server).
5. **SMS code not arriving.** SMS uses \`SMS_PROVIDER\` (\`textlink\` / \`twilio\`), with the same console fallback if credentials are missing (\`sns\` not wired). The user must also have a verified SMS phone enrolled. Fix: configure the SMS provider and confirm SMS enrollment.

## Tips
- Check spam/junk first — short code emails are often filtered.
- Codes and links are short-lived; request a fresh one rather than reusing an old message.
- The Outbound notifications log is the single source of truth for "did it leave the building."
- Operators: console-fallback sends appear only in the API container logs, never in an inbox — a sign the provider isn't really configured.
`),
  },
  {
    slug: 'ai-not-working',
    category: 'troubleshooting',
    title: 'The AI assistant is disabled or not answering',
    summary: 'Provider, budget, and egress checks.',
    tags: ['troubleshooting', 'ai', 'chat'],
    sortOrder: 30,
    body: md(`
# Ask AI / AI features aren't available

AI panels (description suggestions, narratives, the support chat, plain-English queries) are hidden, greyed out, or returning errors. The app gates every AI feature behind several checks; the status endpoint tells you which one is failing.

## Symptoms
- AI buttons/panels don't appear at all in the staff app.
- An AI action returns \`no_ai_provider\` (503), \`ai_budget_exhausted\` (402), or \`ai_provider_failed\` (502).
- AI worked, then suddenly stopped mid-month.
- Cloud AI is configured but calls still behave as if no provider exists.

## Causes & fixes
1. **Check \`/api/staff/ai/status\` first.** It returns \`enabled\`, \`optedIn\`, \`providerWired\`, and \`providerId\`, where \`enabled = optedIn && providerWired\`. The UI hides AI panels whenever \`enabled\` is false.
2. **No provider wired (\`providerWired: false\`, \`no_ai_provider\`).** Local is preferred: set a local provider (Ollama URL + model) or a cloud provider (\`AI_CLOUD_API_KEY\` + model). Fix: configure at least one and restart the API.
3. **Firm opted out (\`optedIn: false\`).** Controlled by \`VIBE_AI_DISABLED\`; when \`true\`, all AI is disabled. Fix (operator): unset it and restart.
4. **Budget exhausted (\`ai_budget_exhausted\`, 402).** A per-firm monthly budget is checked against month-to-date spend in \`ai_request_log\`. At the warn threshold (default 80%) calls still succeed with a warning; at 100% they're hard-capped. Fix: raise the budget in **Admin → Firm settings**, or wait for the reset (the response includes \`resetsOn\`). Review usage in **Admin → AI usage**.
5. **Cloud blocked by egress / Vibe Shield.** Cloud calls only happen when the firm has egress enabled AND a Shield endpoint set AND Shield is currently reachable (a healthcheck refreshes reachability in Redis). With egress off (the secure default) every call is forced local, and a cloud override is silently downgraded. Fix: enable egress + set a reachable Shield endpoint, or wire a local provider so AI works offline.
6. **Provider configured but failing (\`ai_provider_failed\`, 502).** The provider was reached but errored (model not pulled in Ollama, bad cloud key, timeout). Fix: confirm the local model is downloaded / the cloud key is valid; failures are recorded in the AI request log.

## Tips
- Local-first is the design: a wired local provider keeps AI working even when cloud egress is denied.
- The support chat is grounded only in published Knowledge Base articles and will say so plainly if nothing matches — that's expected.
- Admins can see per-feature request counts, cost, latency, and failures under **Admin → AI usage**.
`),
  },
  {
    slug: 'tunnel-offline',
    category: 'troubleshooting',
    title: 'Cloudflare tunnel shows offline',
    summary: 'The connector isn’t reaching Cloudflare.',
    tags: ['troubleshooting', 'cloudflare', 'tunnel', 'offline'],
    sortOrder: 40,
    body: md(`
# Cloudflare tunnel shows offline or provision failed

The Cloudflare Tunnel exposes the appliance on your own domain (\`app.<zone>\`, \`portal.<zone>\`) without opening inbound ports. Two distinct problems look similar in the admin UI: the tunnel was never provisioned successfully (\`provision_failed\`), or it was provisioned but the connector isn't currently running ("offline").

## Symptoms
- Tunnel status reads \`INACTIVE\`, \`ERROR\`, or the UI shows "sidecar offline."
- Provisioning returns \`provision_failed\` (502) with a Cloudflare error message.
- The public hostname returns a Cloudflare error page or times out.
- The status snapshot shows \`ready: false\` / zero connectors.

## Causes & fixes
1. **Connector (cloudflared sidecar) isn't running ("offline").** A worker polls the sidecar's local metrics endpoint (\`http://cloudflared:2000\`, \`/ready\` + \`/metrics\`) about once a minute; if it's unreachable it records \`ready: false\`, which the UI renders as offline. Fix (operator): ensure the \`cloudflared\` service is up. It waits for the token file (\`/run/cloudflared/token\`) and only starts once provisioning has written it — if the tunnel was never provisioned, there's no token and the sidecar idles by design. Provision from the admin UI, then confirm the container starts.
2. **Caddy isn't serving the tunnel origin on \`:80\`.** The tunnel ingress forwards to \`http://caddy:80\` and rewrites the Host header to \`app.<zone>\` / \`portal.<zone>\` (TLS is terminated at Cloudflare's edge, so plain HTTP here is fine). If Caddy isn't listening on \`:80\`, the tunnel is "up" but origin requests fail. Fix (operator): confirm Caddy handles \`:80\` (the local Caddyfile's \`:80\` block; prod maps \`80:80\`).
3. **\`provision_failed\` — orphan tunnel of the same name.** A prior failed provision can leave a Cloudflare tunnel whose id never reached the DB, so a fresh create fails ("tunnel with this name already exists", code 1013). Provisioning tries to delete the orphan first, but a permissions gap can block cleanup. Fix: ensure the API token can list/delete tunnels, then re-provision; the status row is stamped \`ERROR\` with the Cloudflare message.
4. **\`provision_failed\` — bad token, account, or zone.** Any Cloudflare API rejection surfaces as \`provision_failed\` with the underlying message. Fix: verify the API token scopes (account tunnels + zone DNS edit), the account id, and the zone id; read the **Last error** box for the exact message.
5. **Portal hostname has no DNS yet.** Portal ingress and DNS are only created when a commercial license is active; PORTAL hostnames are recorded but get no CNAME until licensed. Fix: confirm the license, then re-provision.

## Tips
- Each ingress rule uses \`connectTimeout: 30\` (seconds) and \`noTLSVerify: true\` against the in-network Caddy origin — these are expected, not errors.
- "Offline" (connector down) and "provision failed" (Cloudflare API rejected setup) are different problems — check the metrics snapshot for the former and **Last error** for the latter.
- After fixing credentials or DNS, re-provision from the admin UI; editing hostnames via **Save changes** updates in place without disturbing the connector.
- The sidecar reads only the token file, so it does not need restarting when hostnames change.
`),
  },

  // =================================================================== OpenSign e-sign
  {
    slug: 'esign-providers',
    category: 'proposals',
    title: 'E-signatures: native vs OpenSign',
    summary: 'The two e-signature backends and how to choose.',
    tags: ['e-sign', 'signature', 'opensign', 'native', 'proposals'],
    sortOrder: 40,
    body: md(`
# E-signatures: native vs OpenSign

Proposals are signed electronically. The firm chooses one of two e-signature backends in **Admin → Firm settings → E-sign provider**:

- **Native** (default) — the built-in signer. The client signs **inside the Vibe client portal** (typed name or drawn signature). Each signature is sealed with a per-firm HMAC and is independently verifiable. No setup, no extra services.
- **OpenSign** (optional) — an external open-source e-signature service run as an isolated sidecar. The client signs in **OpenSign's own signing UI**, which produces a signed PDF + a completion certificate. Richer signing experience, at the cost of running and configuring the OpenSign stack.

## How they differ
- **Where signing happens:** native = the Vibe portal; OpenSign = OpenSign's UI (the portal redirects the signer there).
- **Completion:** native is synchronous (the signature lands as the client submits); OpenSign is asynchronous — OpenSign notifies the appliance via a signed webhook (with a worker poll as a safety net), then the signature is recorded.
- **Setup:** native needs none; OpenSign requires standing up the sidecar and configuring it (see *Enabling OpenSign e-signatures*).
- **Artifacts:** OpenSign additionally stores a signed PDF + certificate in the firm's own object storage.

## What you'll see
- The **E-sign provider** selector in firm settings only enables the **OpenSign** option when OpenSign is configured on the appliance (\`OPENSIGN_URL\` set). Until then it stays on **Native** and any mis-set value falls back to native with a logged warning.
- The signer roster, signing order (parallel/sequential), and the all-required-signers gating that flips a proposal to **ACCEPTED** and freezes the engagement work the same way under **both** providers — including mixed rosters.

## Tips
- Native is the right choice for most firms — it's legally binding, verifiable, and zero-maintenance.
- Pick OpenSign only if you specifically want OpenSign's signing UI / certificate workflow and are willing to run the sidecar.
- Switching the provider only affects **new** signing sessions; in-flight signatures keep their original backend.
`),
  },
  {
    slug: 'opensign-signing',
    category: 'proposals',
    title: 'Signing a proposal with OpenSign',
    summary: 'The send → portal → OpenSign signing flow when OpenSign is active.',
    tags: ['opensign', 'e-sign', 'signature', 'proposals', 'portal'],
    sortOrder: 50,
    body: md(`
# Signing a proposal with OpenSign

When the firm's e-sign provider is **OpenSign**, sending a proposal works exactly as usual — the difference is where and how the client signs. Vibe keeps ownership of the brochure, package selection, and any Stripe ACH mandate; OpenSign handles only the signature.

## Steps
1. Build and **Send** the proposal as normal (define the signer roster + order; see *Building and sending proposals* and the multi-signer notes).
2. The client opens their **portal magic link** and reviews the proposal, selects a package, and confirms payment details **in the Vibe portal**.
3. When the client clicks **Sign**, the portal calls the OpenSign "start signing" step and **redirects the browser to OpenSign's signing UI** (URL of the form \`<opensign>/load/recipientSignPdf/<documentId>/<contactId>\`).
4. The client signs in OpenSign. On completion OpenSign sends a **signed webhook** back to the appliance; if that's ever missed, a worker **poll runs every ~2 minutes** as a safety net.
5. The appliance records the signature: the signer row flips to **SIGNED**, and the **signed PDF + certificate** are fetched from OpenSign and stored in the firm's own object storage (under \`opensign-certs/…\`).
6. Once **all required signers** have completed (parallel or sequential), the proposal flips to **ACCEPTED** and the engagement scope is frozen — exactly once.

## What you'll see
- In **sequential** mode, the next signer's link is issued only after the prior signer completes; in **parallel** mode all signers can sign in any order.
- A **declined** signer (in OpenSign) sets that signer's row to **DECLINED** and moves the proposal to **IN_PROGRESS** (staff-recoverable — you can replace/re-invite that signer).
- Mixed rosters work: some signers can be native and some OpenSign on the same proposal; the proposal only completes when every required signer is done.

## Tips
- The signing URL is reached **through the portal**, not emailed raw — so the client always passes through the Vibe brochure/package/payment step first.
- The certificate and signed PDF live in **your** storage, not OpenSign's — OpenSign never receives your storage credentials.
- If a signature seems stuck after the client signed, the poll will reconcile it within a couple of minutes; see *OpenSign signing isn't completing*.
`),
  },
  {
    slug: 'opensign-setup',
    category: 'integrations',
    title: 'Enabling OpenSign e-signatures',
    summary: 'Stand up the OpenSign sidecar and wire it to the appliance.',
    tags: ['opensign', 'e-sign', 'setup', 'integration', 'admin'],
    sortOrder: 30,
    body: md(`
# Enabling OpenSign e-signatures

OpenSign is an **optional**, per-firm e-signature backend (native is the default). It runs as an isolated **AGPL** sidecar reached over HTTP — the appliance never bundles or links OpenSign source. This is an operator/admin task; the full reference is \`ops/docs/opensign-runbook.md\`.

Important: the **self-hosted** OpenSign API is its **Parse Server cloud-function** API (\`/api/app/functions/…\`, authed with the Parse app id + master key) — **not** the hosted SaaS REST API or \`x-api-token\` (those don't exist on self-host).

## Steps
1. **Stand up the OpenSign stack** (four services — server, client, MongoDB, Caddy) from \`ops/docker/opensign/\`:
   - \`docker compose -f ops/docker/opensign/docker-compose.yml up -d\`
   - The UI comes up at \`https://localhost:4001\` (self-signed cert). Note the \`APP_ID\` + \`MASTER_KEY\` from \`ops/docker/opensign/.env.prod\`.
2. **Create an OpenSign account** in that UI — this user becomes the document owner. (Create it through the UI; the API signup path is unreliable on the current build.)
3. **Mint the webhook key**: in OpenSign, go to **Settings → Webhook**, generate the 64-character **Webhook Security Key**, and register the webhook URL \`https://<appliance>/api/webhooks/opensign\` for the events \`created / viewed / signed / completed / declined\`.
4. **Set the appliance env** (read by both api and worker) and restart them:
   - \`OPENSIGN_URL\` — the OpenSign API base reachable from the appliance.
   - \`OPENSIGN_APP_ID\` (default \`opensign\`) and \`OPENSIGN_MASTER_KEY\` (from \`.env.prod\`).
   - \`OPENSIGN_PUBLIC_URL\` — used to build signer URLs.
   - \`OPENSIGN_API_EMAIL\` / \`OPENSIGN_API_PASSWORD\` — the account from step 2.
   - \`OPENSIGN_WEBHOOK_SECRET\` — the key from step 3.
5. **Flip the firm to OpenSign**: **Admin → Firm settings → E-sign provider → OpenSign**, Save.

## What you'll see
- Setting \`OPENSIGN_URL\` is what makes the **OpenSign** option selectable in firm settings; while it's unset the appliance stays native-only.
- The webhook endpoint \`POST /api/webhooks/opensign\` returns **503** until \`OPENSIGN_WEBHOOK_SECRET\` is configured (mounted but inert) — that's expected before setup.
- On completion the appliance fetches the signed PDF + certificate from OpenSign and stores them in the firm's object storage; OpenSign is never given storage credentials.

## Tips
- Keep the master key and the Webhook Security Key secret; rotate them together.
- OpenSign brings its own MongoDB + signing certificate and adds real resource cost — leave it off unless a firm needs it.
- Reach OpenSign either via its Caddy URL or, if co-located, by attaching api/worker to its docker network and using the in-network server address.
`),
  },
  {
    slug: 'opensign-troubleshooting',
    category: 'troubleshooting',
    title: "OpenSign signing isn't completing",
    summary: 'Provider not selectable, webhook 503/401, or stuck signatures.',
    tags: ['troubleshooting', 'opensign', 'e-sign', 'webhook'],
    sortOrder: 50,
    body: md(`
# OpenSign signing isn't completing

OpenSign signing is asynchronous, so most issues are configuration or webhook delivery — not the signature itself.

## Symptoms
- The **OpenSign** option is greyed out / not selectable in firm settings.
- The webhook endpoint returns 503 or 401.
- The client signed in OpenSign but the proposal never advances.

## Causes & fixes
1. **OpenSign option not selectable.** \`OPENSIGN_URL\` is unset, so the appliance is native-only (dormant). Fix: set the \`OPENSIGN_*\` env on **both** api and worker and restart (see *Enabling OpenSign e-signatures*).
2. **Webhook returns 503 \`not configured\`.** \`OPENSIGN_WEBHOOK_SECRET\` isn't set on the appliance — the route is mounted but can't verify deliveries. Fix: mint the Webhook Security Key in OpenSign and set the env, then restart.
3. **Webhook returns 401.** The HMAC didn't match — the appliance's \`OPENSIGN_WEBHOOK_SECRET\` differs from the key registered in OpenSign. Fix: re-copy the exact 64-char key into the env on both sides.
4. **Client signed but nothing happened.** The webhook may have been blocked (network/firewall between OpenSign and the appliance). The worker **poll** reconciles stuck OpenSign signatures every ~2 minutes, so it usually self-heals. If not, confirm \`OPENSIGN_URL\` is reachable from the api/worker containers and that the document's webhook events are registered.
5. **Signature recorded but no certificate/PDF.** The appliance fetches the signed PDF + certificate from OpenSign and stores them in the firm's object storage. Fix: confirm object storage is configured/healthy and that \`OPENSIGN_API_EMAIL\`/\`PASSWORD\` are valid (the fetch uses an OpenSign session).
6. **Can't create the OpenSign account via API.** Use the OpenSign **UI** to create the document-owner account — the API signup path is unreliable on the current build.

## Tips
- "Dormant" (no \`OPENSIGN_URL\`) and "misconfigured" (503/401) are different states — check whether the option is even selectable before chasing webhooks.
- Native e-sign keeps working throughout; you can always switch a firm back to **Native** in firm settings if OpenSign is down.
- Full setup + the verified cloud-function contract live in \`ops/docs/opensign-runbook.md\`.
`),
  },

  // =================================================================== Using Your Portal
  // Client-facing (audience 'both'): these surface in the portal help center
  // and ground the portal AI support chat. Written FOR the client, not staff.
  {
    slug: 'client-signing-in',
    category: 'client-help',
    title: 'Signing in to your portal',
    summary: 'How to sign in with a secure link and a one-time code.',
    tags: ['portal', 'sign in', 'login', 'access'],
    sortOrder: 10,
    audience: 'both',
    body: md(`
# Signing in to your portal

Your firm's client portal lets you view invoices, pay securely, share documents, and message your team — all in one place.

## How sign-in works
1. Go to your firm's portal web address (your firm will share the link, e.g. \`portal.yourfirm.com\`).
2. Enter your email or mobile number and request a sign-in link or code.
3. Open the email or text and click the link (or enter the 6-digit code).
4. The first time you sign in on a new device, we send a quick one-time code to confirm it's really you.

## Tips
- There's no password to remember — each sign-in uses a fresh secure link or code.
- Links expire after a short time for your security. If yours expired, just request a new one.
- If you have access to more than one account (for example, a business and your personal return), use **Switch** in the menu to move between them.

If you can't sign in, contact your firm — they can re-send your invitation or update your email or mobile number.
`),
  },
  {
    slug: 'client-viewing-paying-invoices',
    category: 'client-help',
    title: 'Viewing and paying invoices',
    summary: 'Find your invoices and pay securely by card or bank transfer.',
    tags: ['invoices', 'pay', 'payment', 'billing'],
    sortOrder: 20,
    audience: 'both',
    body: md(`
# Viewing and paying invoices

## Find your invoices
Open **Invoices** from the menu. You'll see what's due, what's paid, and the amount outstanding. Select any invoice to see the detail and download a PDF.

## Pay an invoice
1. Open the invoice and choose **Pay**.
2. Enter your card or bank (ACH) details on the secure payment screen.
3. Submit — you'll see a confirmation and the invoice updates to paid.

## Good to know
- Payments are processed securely; your firm never sees your full card number.
- If you've saved a payment method, you can reuse it next time.
- A processing fee may be added depending on your firm's settings and the payment type — it's shown before you confirm.
- Some documents unlock automatically once the related invoice is paid.

Questions about a charge? Use **Messages** to ask your firm directly.
`),
  },
  {
    slug: 'client-uploading-documents',
    category: 'client-help',
    title: 'Uploading requested documents',
    summary: 'Respond to document requests and upload files securely.',
    tags: ['documents', 'upload', 'requests', 'files'],
    sortOrder: 30,
    audience: 'both',
    body: md(`
# Uploading requested documents

When your firm needs paperwork from you (W-2s, receipts, statements), they'll send a **request**.

## Respond to a request
1. Open **Requests** from the menu — open items show what's needed.
2. Select a request to see the checklist and any notes.
3. Choose **Upload** and pick your files (PDF, images, and common document types are supported).
4. Mark items complete as you go; your firm is notified automatically.

## Upload files any time
You can also open **Files** to upload or view documents your firm has shared with you, even without a specific request.

## Tips
- Clear photos of paper documents are fine — make sure the whole page is in frame and readable.
- Large files may take a moment to upload; wait for the confirmation before closing.
- Everything you upload is encrypted and visible only to your firm.
`),
  },
  {
    slug: 'client-messaging-your-firm',
    category: 'client-help',
    title: 'Messaging your firm',
    summary: 'Send secure messages and attachments to your team.',
    tags: ['messages', 'contact', 'secure messaging'],
    sortOrder: 40,
    audience: 'both',
    body: md(`
# Messaging your firm

Use **Messages** to communicate securely with your firm instead of regular email.

## Send a message
1. Open **Messages** from the menu.
2. Type your message and attach files if needed.
3. Send — your firm is notified and can reply in the same thread.

## Why use portal messages
- Messages are encrypted and tied to your account, so sensitive details stay protected.
- Everything stays in one place, so nothing gets lost in a crowded inbox.
- You'll get a notification when your firm replies.

For time-sensitive matters, your firm's phone number and email are on the portal — check the footer or your welcome message.
`),
  },
  {
    slug: 'client-your-appointments',
    category: 'client-help',
    title: 'Your appointments',
    summary: 'See upcoming meetings and add them to your calendar.',
    tags: ['appointments', 'meetings', 'calendar', 'schedule'],
    sortOrder: 50,
    audience: 'both',
    body: md(`
# Your appointments

Open **Appointments** to see meetings your firm has scheduled with you.

## What you'll see
- Upcoming meetings with the date, time, and how to join (video link, phone, or in person).
- Who you're meeting with at the firm.
- Recent past appointments.

## Add to your calendar
Choose **Add to calendar** on an appointment to download a calendar file you can open in Outlook, Google Calendar, or Apple Calendar.

If you need to reschedule or have a question about a meeting, send your firm a message from the **Messages** tab.
`),
  },
  {
    slug: 'client-getting-help',
    category: 'client-help',
    title: 'Getting help',
    summary: 'Use the in-portal assistant or contact your firm.',
    tags: ['help', 'support', 'assistant', 'ai'],
    sortOrder: 60,
    audience: 'both',
    body: md(`
# Getting help

## Ask the portal assistant
Open **Help** and use **Ask AI** to get instant answers about using the portal — paying an invoice, uploading documents, finding a statement, and more. The assistant answers from your firm's help articles.

## Browse help articles
The **Help** section also has short how-to articles you can read any time.

## Contact your firm
For anything about your specific account, returns, or charges, message your firm directly from **Messages** — they're the best source for account-specific answers. The assistant won't have access to your private records and will point you to your firm for those.
`),
  },

  // =================================================================== Scheduling & Appointments
  {
    slug: 'connect-your-calendar',
    category: 'scheduling',
    title: 'Connect your calendar (Microsoft 365 or Google)',
    summary: 'Link your own calendar so your free/busy drives booking and appointments sync.',
    tags: ['calendar', 'microsoft', 'm365', 'outlook', 'google', 'connect', 'oauth', 'sync'],
    sortOrder: 10,
    body: md(`
# Connect your calendar

Linking your calendar lets the app read your free/busy so booking only offers times you're actually open, and (when write-back is on) it adds the appointments you book straight to your calendar — with updates and cancellations kept in sync.

You connect **your own** calendar by signing in with your own Microsoft or Google account. You only ever grant access to your own mailbox; there's nothing to install and no firm-wide setup on your part.

## Connect it
1. Open **Account → My Calendars**.
2. Click **Connect Microsoft 365** or **Connect Google**.
3. Sign in to your provider and approve the access request.
4. You'll land back on **My Calendars** marked **Connected**.

> Don't see a Connect button? Your firm hasn't enabled a calendar provider yet. Ask an admin to set one up (see *Set up the calendar connection (admin)*).

## Choose which calendars sync
After connecting, pick which of your calendars should be used. Use:
- **Sync now** to pull the latest events immediately.
- **Refresh calendars** if you just created a new calendar and don't see it.
- **Disconnect** to unlink — appointments already booked are kept.

## What connecting unlocks
- You appear in the **Book** wizard with a provider badge (M365 / Google), and your real availability shapes the open time slots.
- New bookings are written to your calendar; reschedules and cancellations update the event.
- Connection health (including any "read-only — reconnect to grant write access" warnings) shows under **Settings → Calendar overview**.

## Keeping it healthy
If your connection shows an error or "needs reconnect," open **Account → My Calendars** and connect again — that refreshes the access the provider granted.
`),
  },
  {
    slug: 'booking-appointments',
    category: 'scheduling',
    title: 'Book an appointment',
    summary: 'Use the four-step wizard to schedule a meeting with one or more staff.',
    tags: ['appointments', 'booking', 'schedule', 'meeting', 'calendar', 'wizard'],
    sortOrder: 20,
    body: md(`
# Book an appointment

Open **Appointments → Book** (or click **Book appointment**). The booker walks through four steps.

## Step 1 — Staff & type
- Pick one or more **staff members**. With more than one selected, the app only offers times when **everyone** is free.
- Choose an **appointment type** (e.g. Tax Preparation, Tax Planning). The type pre-fills the default duration and location — you can override either.
- Set the **duration**, **location** (In-person / Phone / Video), and an optional detail (video link, phone number, or address).

## Step 2 — Date & time
- Days with openings show in **bold**; faded days have no availability. Today is outlined.
- Pick a day, then choose a time. Taken times are struck through. For multi-staff bookings, the dots under each time show each person's free/busy.

## Step 3 — Client & details
- Optionally attach a **client**, then check the **participants** to invite (each gets a confirmation email).
- Optionally link an **engagement** (a note is added to it), set the **subject**, and add **internal notes** (staff-only — never sent to the client).

## Step 4 — Review & confirm
Check the summary, then **Confirm booking**. The app then:
- Adds the event to each selected staff member's connected calendar.
- Emails participants a confirmation with cancel / reschedule links and a calendar invite.
- Adds a note to the linked engagement, if any.

## After booking
Manage everything under **Appointments**:
- The **list** supports filters (status, staff, type, client, date) and shows the staff on each appointment.
- Open an appointment to **reschedule**, **cancel**, retry a failed calendar write, or review participant RSVPs.
- Client reschedule requests arrive in the **Reschedule inbox** (and as a notification) where you can propose a new time or decline.
`),
  },
  {
    slug: 'appointment-types',
    category: 'scheduling',
    title: 'Set up appointment types (admin)',
    summary: 'Define the bookable meeting types that appear in the booking wizard.',
    tags: ['appointment types', 'admin', 'settings', 'booking', 'duration'],
    sortOrder: 30,
    body: md(`
# Set up appointment types

Appointment types are the cards staff pick in the **Book** wizard — they set a default duration, location, and color. Manage them under **Settings → Appointment types**.

## Add the starter set
On a new firm, click **Add default types** to seed a CPA-oriented set: Initial Consultation, Tax Preparation, Tax Planning, Tax Return Review, Advisory / Planning Meeting, Document Drop-off, and Phone Call. Then tailor them to your firm.

## Create or edit a type
For each type you can set:
- **Name** and an optional **description** (shown to staff on the booking form).
- **Default duration** and **default location** (the booker can override per appointment).
- A **color** (used as the dot in the wizard and the list).
- **Active** toggle — inactive types are hidden from the booker but kept for history.
- **Order** — use the up/down arrows to control how they appear.

## Deleting vs deactivating
A type that has appointment history **cannot be deleted** — deactivate it instead so past appointments keep their type. Types with no history can be deleted outright.
`),
  },
  {
    slug: 'calendar-oauth-setup',
    category: 'admin',
    title: 'Set up the calendar connection (admin)',
    summary: 'Enable Microsoft 365 / Google so staff can link their calendars.',
    tags: ['calendar', 'admin', 'oauth', 'microsoft', 'google', 'setup', 'integration'],
    sortOrder: 120,
    body: md(`
# Set up the calendar connection

Before staff can link calendars, a calendar provider must be enabled. There are two ways to supply the OAuth app the connection needs.

## Option A — Built-in (appliance) app (recommended)
The operator registers **one** OAuth app per provider and sets its credentials in the appliance environment. After that, **every staff member just signs in** to link their own calendar — there's no per-firm setup and no organization-wide admin consent.

Environment variables:
- \`CALENDAR_MS_CLIENT_ID\`, \`CALENDAR_MS_CLIENT_SECRET\`, \`CALENDAR_MS_TENANT_ID\` (use \`common\` for work + personal accounts)
- \`CALENDAR_GOOGLE_CLIENT_ID\`, \`CALENDAR_GOOGLE_CLIENT_SECRET\`

Register these redirect URIs on the app (replace the host with your app's base URL):
- \`https://<your-app-host>/api/calendar/oauth/callback/microsoft\`
- \`https://<your-app-host>/api/calendar/oauth/callback/google\`

Microsoft: register a **multi-tenant** app and request the delegated scopes \`Calendars.ReadWrite\` and \`offline_access\` — these are user-consentable, so each staff member approves access for their own mailbox.

When this is configured, **Settings → Calendar integrations** shows a "built-in app active" banner and the per-firm fields below are optional.

## Option B — Your firm's own app
A firm can instead paste its own OAuth app credentials under **Settings → Calendar integrations**: enter the Client ID / Secret (and Tenant ID for Microsoft), use **Test Connection**, then enable the provider. Secrets are encrypted at rest and never shown again.

## After enabling
Staff connect from **Account → My Calendars** (see *Connect your calendar*). Monitor connection health under **Settings → Calendar overview**; appointment write-back additionally requires the \`FEATURE_CALENDAR_WRITE\` flag to be on.
`),
  },
];

export async function seedKnowledgeBase(
  tx: Tx,
  firmId: string,
): Promise<{ categories: number; articles: number }> {
  for (const c of KB_CATEGORIES) {
    await tx
      .insert(kbCategories)
      .values({
        firmId,
        slug: c.slug,
        title: c.title,
        description: c.description,
        sortOrder: c.sortOrder,
      })
      .onConflictDoUpdate({
        target: [kbCategories.firmId, kbCategories.slug],
        set: {
          title: c.title,
          description: c.description,
          sortOrder: c.sortOrder,
          updatedAt: new Date(),
        },
      });
  }

  const cats = await tx
    .select({ id: kbCategories.id, slug: kbCategories.slug })
    .from(kbCategories)
    .where(eq(kbCategories.firmId, firmId));
  const idBySlug = new Map(cats.map((c) => [c.slug, c.id]));

  for (const a of KB_ARTICLES) {
    await tx
      .insert(kbArticles)
      .values({
        firmId,
        categoryId: idBySlug.get(a.category) ?? null,
        slug: a.slug,
        title: a.title,
        summary: a.summary,
        bodyMarkdown: a.body,
        tags: a.tags,
        status: 'PUBLISHED',
        audience: a.audience ?? 'staff',
        isSystem: true,
        sortOrder: a.sortOrder,
      })
      // System articles are code-owned: refresh content on every deploy.
      // Admin-authored articles use different slugs and are never touched.
      // (Status is intentionally left out of the update so an admin who
      // archives a system article keeps it archived.)
      .onConflictDoUpdate({
        target: [kbArticles.firmId, kbArticles.slug],
        set: {
          categoryId: idBySlug.get(a.category) ?? null,
          title: a.title,
          summary: a.summary,
          bodyMarkdown: a.body,
          tags: a.tags,
          audience: a.audience ?? 'staff',
          sortOrder: a.sortOrder,
          updatedAt: new Date(),
        },
      });
  }

  // Prune system articles that are no longer shipped (renamed/removed),
  // leaving firm-authored (is_system=false) articles intact.
  const shippedSlugs = KB_ARTICLES.map((a) => a.slug);
  await tx
    .delete(kbArticles)
    .where(
      and(
        eq(kbArticles.firmId, firmId),
        eq(kbArticles.isSystem, true),
        notInArray(kbArticles.slug, shippedSlugs),
      ),
    );

  // Prune stale categories: not in the shipped set AND no longer referenced
  // by any article. Keeps shipped categories and any admin category that
  // still has articles.
  const shippedCatSlugs = KB_CATEGORIES.map((c) => c.slug);
  const referenced = await tx
    .select({ categoryId: kbArticles.categoryId })
    .from(kbArticles)
    .where(eq(kbArticles.firmId, firmId));
  const referencedIds = new Set(
    referenced.map((r) => r.categoryId).filter((id): id is string => !!id),
  );
  const allCats = await tx
    .select({ id: kbCategories.id, slug: kbCategories.slug })
    .from(kbCategories)
    .where(eq(kbCategories.firmId, firmId));
  const staleCatIds = allCats
    .filter((c) => !shippedCatSlugs.includes(c.slug) && !referencedIds.has(c.id))
    .map((c) => c.id);
  if (staleCatIds.length > 0) {
    await tx
      .delete(kbCategories)
      .where(and(eq(kbCategories.firmId, firmId), inArray(kbCategories.id, staleCatIds)));
  }

  return { categories: KB_CATEGORIES.length, articles: KB_ARTICLES.length };
}
