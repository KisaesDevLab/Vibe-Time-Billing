---
title: 'Approving portal access requests'
slug: portal-access-requests
category: client-portal
audience: staff
tags: ['portal', 'access', 'requests', 'approvals', 'invite']
---

# Approving portal access requests

Instead of waiting for staff to invite them, a client (or an authorized person on the account) can request portal access themselves from a public page. Requests land in an approval queue where staff verify identity and grant access.

## How a client requests access

On the portal's **Request access** page (no login required) the person enters their email or phone, picks _Individual_ or _Business_, and types the **last four digits** of the SSN or EIN on file. They always see the same neutral confirmation — "if your information matches our records, we'll review your request" — whether or not there was a match. This keeps the page from leaking who is and isn't a client.

When the details match a person in your directory, the system creates one pending request for **each client** that person is a contact of — and skips any client where they already have active access.

## How staff approve or deny

1. Open **Approvals** and find the **Portal access requests** card (requires the portal-access permission).
2. Each row shows the person's name, the client, the contact details they submitted, and the last-4 ID value they entered.
3. **Verify the ID** against what you have on file (the value is shown for you to eyeball; the app does not auto-check it).
4. To approve, pick a role — _Full_, _View only_, or _Pay only_ — and click **Approve**. The person is granted access immediately if they've signed in before, or sent an invitation link if not.
5. To reject, click **Deny**. No access is granted and the requester is not notified.

## Tips

- Approval uses the same grant/invite path as a manual invite, so an existing login is reused rather than duplicated.
- Re-submitting while a request is already pending does nothing — there's one pending request per person-and-client.
- The page is rate-limited and enumeration-safe per the firm's standard mitigation, so repeated guessing reveals nothing.
- Manage the resulting logins anytime from the [[people-directory]].
