---
title: 'Tracking and releasing tax returns'
slug: tax-returns-overview
category: tax-returns
audience: staff
tags: ['tax', 'returns', '1040', 'k-1', 'release']
---

# Tracking and releasing tax returns

The Tax area is where your firm tracks finished tax returns and delivers them to clients through the portal. It is a tracking-and-delivery workflow, not a tax-preparation tool: returns are prepared in your tax software, then flagged or parsed into the app so you can review their sections, release the right pages to the right client, and see who has viewed them. Open it from the **Tax** nav entry, which lands on the **Returns** tab.

## Steps

1. On the **Returns** tab, the table lists every return with columns **Client**, **Year**, **Form** (`formCode · jurisdiction`), **Title**, **Type**, **Status**, **Pages**, and **Released**.
2. If no returns exist yet you'll see **"No tax returns yet"** — returns appear once parsed into the system.
3. Click a client name to open that return's detail page.
4. Review the header card, the **Client**, the **Sections** card, and the **Active releases** card.
5. Click **Release to client** to open the **Release tax return to client** dialog.
6. In **Released to client (UUID)**, confirm or change the target client (defaults to the return's own client).
7. Choose a **Scope**: **Full return** (every page) or **Selected sections** (a section picker appears).
8. For **Selected sections**, tick sections to include (each shows its title and page range `pp {start}–{end}`). At least one section is required.
9. Set **Client can download the PDF** on or off (on by default; off means view-only).
10. Optionally add a **Cover note (optional)** (up to 2000 characters).
11. Click **Release**. The new release appears under **Active releases**.
12. To pull back access, click **Revoke** on a release row and confirm. The client loses access immediately.

## Fields

- **Status** — `DRAFT`, `PARSED`, `REVIEW`, `APPROVED`, `RELEASED`, or `SUPERSEDED`.
- **Type** (release kind) — `ORIGINAL`, `AMENDED`, or `SUPERSEDED`.
- **Scope** — `FULL` or `SELECTED`. Withheld sections never appear to the client.
- **Sections** — each has a title, a kind (e.g. `COVER`, `MAIN_FORM`, `SCHEDULE`, `K1`, `STATE`), and a page range.

## What you'll see

- The detail page shows **Sections (n)** with titles and page ranges, and **Active releases (n)** listing who each release went to, the scope (**Full return** or **N sections**), whether download is enabled, and the release date.
- Selective releases are enforced server-side: with **Selected sections**, the client's viewer only shows the released sections — they never learn the withheld ones exist.
- Listing and viewing require `engagement:read`; creating and revoking releases require `engagement:write`.

## Tips

- A return with no parsed sections can only be released as **Full return**.
- To gather signatures on a return (e.g. e-file authorizations), use **Collect signatures** on the return — it detects the signature pages and builds a signing package. See [[collect-signatures-from-return]].
- Clients can re-share a release with a third party (e.g. a bank or lender) from their own portal as a tokenized recipient link with optional 2FA, an expiry, view-only or view-and-download, and a watermark. Staff see active shares in the viewer's "Shared with" rail.
- A **full-return** re-share requires the client to hold a **full** release — if you only released selected sections, the client can't re-share the entire return, only what they were given.
- To preview exactly what a client sees, use **View as client ↗** on the client's **Portal access** card. It opens the portal read-only; the launch token is single-use and expires 5 minutes after it's issued.
- Every release, revoke, view, and section edit is written to the return's access log for audit.
