---
title: 'Secure engagement messaging'
slug: engagement-messaging
category: messaging
audience: staff
tags: ['messaging', 'encryption', 'threads']
---

# Secure engagement messaging

Every engagement has a private, encrypted message thread shared between your staff and the client's portal contacts. Threads are scoped to a single engagement (and its client), every message body is encrypted at rest, and clients read and reply through the branded portal — never email.

## Steps

1. Open **Messages** from the staff navigation. The left card is titled **Threads (N)**; the right card shows the selected conversation.
2. Pick a thread on the left. Each row shows the thread title (or "Engagement thread" if untitled) and either "Updated <date/time>" or an **Archived** pill.
3. Read the stream on the right. Staff messages align right and are tagged `· staff`; client messages align left and are tagged `· client`.
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

## Attachments & filing to a folder

Messages can carry **file attachments**, encrypted under the same thread key. When a client sends a document on a thread, staff can **file that attachment into the client's folder** directly from the message — pick the destination folder/category and it's copied into the client's file storage (the original stays on the thread), so you don't have to download and re-upload.

## Client-initiated threads

Clients can now **start** a conversation from their portal, not just reply. A new client-started thread automatically adds the relevant staff (the engagement's team, or firm staff who handle messaging) and notifies them, so it doesn't sit unseen. Client-started threads are rate-limited to curb spam.

## Tips

- Encryption is at-rest: each thread has its own data-encryption key wrapped by the firm key, and the appliance must be unlocked to read or send. Staff and clients never see ciphertext.
- Clients reply from the portal; your sent message appears there immediately.
- During pre-bill review, the **Untracked client interactions** panel surfaces thread messages in a date range that aren't yet linked to a time entry — useful for capturing unbilled communication.
- Reading requires `messaging:read`; posting requires `messaging:write`.
