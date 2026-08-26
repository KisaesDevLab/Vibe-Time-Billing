---
title: 'Access-code share links'
slug: gated-share-links
category: files
audience: staff
tags: ['share', 'access code', 'otp', 'files', 'security']
---

# Access-code share links

When you share a file (or several files) with someone outside the firm, the recipient gets a link to a landing page rather than a direct download. To open it they request a one-time **access code**, which is sent to the email or phone on the share, and enter it to view or download. This protects shared documents even if the link is forwarded.

## Sharing a single file

From a client's **Files** tab, click **Share** on a file. Set the recipient's email (and name/organization if you want them on the watermark), choose **view** or **download** access, set an expiry, and optionally turn on a PDF watermark. The recipient receives the landing-page link.

## Sharing several files at once

Select multiple files in the Files tab and use the toolbar **Share** action. All selected files go into **one** share with a single landing page that lists every file with its own view/download button — the recipient verifies once and sees them all.

## What the recipient does

1. Opens the link and clicks **Send code**.
2. Receives a 6-digit code by email or text (the destination is shown masked).
3. Enters the code. A successful code grants a short browser session to view or download the files.

The code expires after a few minutes, allows a handful of attempts, and has a resend cool-down. Repeated failures lock the challenge and eventually revoke the share automatically.

## Tracking what happened

The Files tab has a **File sharing activity** card at the bottom, in two parts:

- **Secure links sent to outside recipients** — a row per share: file, recipient, access level (and whether it was watermarked), status (Sent / Opened / Expired / Revoked), when it went out, when it was last opened and how many times, and the expiry. **Activity** opens the full trail for that share — access code emailed, code verified, wrong code, lockout, the download itself, and every block — each with time, IP, and browser. **Revoke** kills the link immediately.
- **Client portal activity** — what the client themselves did with their own files while signed in to the portal: which file, who, downloaded or blocked (and why), when, and from what IP. This is separate from share links: no link, no code, they were authenticated.

Nothing here is retroactive-only — both trails have been recorded all along, so shares and portal downloads from before this card existed appear too.

## Tips

- Because the code goes to the recipient's own email/phone, a forwarded link is useless without it.
- A bundle share uses one code for the whole set of files.
- Watermarks apply to PDFs and carry the recipient's name and organization.
- Clients can also create share links from their portal; see [[sharing-and-visibility]]. Older, pre-existing links that pre-date the access-code feature continue to work as before.
