---
title: 'Building and sending proposals'
slug: proposals-overview
category: proposals
audience: staff
tags: ['proposals', 'engagement letter', 'e-sign', 'send']
---

# Building and sending proposals

Proposals are branded, block-based documents you assemble from your services catalog, packages, and terms templates, then send to a client via a secure magic link. The client reviews it section by section, signs electronically, and acceptance automatically converts the proposal into an engagement.

## Steps

1. Go to **Proposals** (`/proposals`). The header reads "Proposals — Draft, send, and track engagement proposals."
2. Click **New proposal**. On the "New proposal" page pick a **Client** and enter a **Title**, then click **Create + open editor**.
3. In the editor, use the **Add block** palette to drop in blocks: `Cover`, `Markdown text`, `Heading`, `Divider`, `Video`, `Services list`, `Package selector`, `Terms`, and `Signature`.
4. Configure each block by selecting its row. For **Services list**, check the services to show and toggle "Show prices in the rendered list." For **Package selector**, pick one package. For **Terms**, choose a terms template.
5. In the **Signers** card, add the signer roster — each signer gets a role of **Primary**, **Co-signer**, or **Witness** — and set the signing order to **Parallel (any order)** or **Sequential (one at a time)**.
6. In the **On acceptance** card, optionally turn on **Create an engagement when the client accepts** and/or **Send a request list on acceptance** to automate post-signature work.
7. Drag the `⋮⋮` handle to reorder; use **Undo**/**Redo** (or Ctrl/Cmd+Z). The editor autosaves about every 2 seconds; click **Save now** to flush immediately.
8. Resolve any validation issues (shown inline and as a counter pill), then click **Send proposal**. This snapshots the document as version 1 with a SHA-256 content hash and flips status `DRAFT → SENT`.
9. Mint a client link; the system returns a URL of the form `<portalBaseUrl>/p/<token>`. Deliver it to the client. Re-minting supersedes the prior unused link.
10. Track progress on the pipeline dashboard (kanban, funnel, time-to-sign, abandoners, stale proposals).

## Fields

- **Client**, **Title** — set on creation; title is editable only while `DRAFT`.
- `Markdown text` supports merge tokens like `{{ client.name }}`, `{{ firm.name }}`, `{{ today }}` resolved at send time.
- **Signature** block: a field label (default "Type your full legal name to sign") and acceptance copy.
- Magic-link lifetime defaults to 30 days (1–180 allowed).

## What you'll see

- Status pills: `DRAFT`, `SENT`, `VIEWED`, `IN_PROGRESS`, `ACCEPTED`, `DECLINED`, `EXPIRED`, `CANCELLED`, `COUNTERED`. The list shows one-time and recurring fee totals plus a revision (`v#`) column.
- When the client first opens the link, status advances `SENT → VIEWED` and a first-viewed timestamp is stamped.
- Section-by-section tracking records dwell time per section/session, so you can see which sections the client lingered on.
- A **Versions** panel shows each immutable snapshot with its content hash — what the client saw at send time hashes to that value forever.

## Tips

- Clients can optionally create a password account (email + Argon2id password) from a magic-link session so they can return without a fresh link.
- A proposal can only be edited while `DRAFT`; sending locks the content. Cancelling sets status `CANCELLED` (not allowed once `ACCEPTED`).
- On acceptance the system records the signature + per-firm HMAC, optionally captures an ACH mandate, marks the selected package, and snapshots a final `ACCEPTED` version. The post-acceptance automation (creating the engagement, sending the request list) is exactly what you toggled in the editor's **On acceptance** card — engagement conversion is idempotent.
- Magic-link redemption is rate-limited per IP (10/hour); tokens are 256-bit random and stored only as SHA-256 hashes.
- The funnel values an engagement as one-time + 12 × recurring; filter the dashboard by date range, owner, and value.
