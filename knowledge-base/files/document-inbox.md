---
title: 'The Document Inbox (Filer)'
slug: document-inbox
category: files
audience: staff
tags: ['filer', 'document inbox', 'routing', 'scan', 'zip import']
---

# The Document Inbox (Filer)

**Document Inbox** (left nav) is the staff queue for getting bulk documents into the right client folders. Drop files (or a tax-software export) into the inbox, and the app reads each filename, matches it to a client, and proposes a destination folder using your routing rules. You review, fix anything it got wrong, and commit — the files move into each client's file storage in one batch.

## The tabs

- **Inbox** — the review queue of documents waiting to be filed.
- **Import** — upload a `.zip` export of client documents (see below).
- **Rules** — the routing rules that turn a filename into a destination folder.
- **History** — every batch you've filed, with the option to undo.

## Working the Inbox

1. Get documents into the inbox by **dragging and dropping** them onto the drop zone, or by having your scanner/export drop them into the storage **Inbox/** prefix.
2. The app parses each filename for a **client identifier**, a document name, and a year, then matches it to a client and suggests a folder.
3. Review each row. Rows are color-coded — matched (ready), a soft warning (matched with a caveat such as a name mismatch), or unmatched (needs a manual client pick).
4. Override anything that's wrong: the **client**, the **destination folder**, or the **year**. You can also flag a document as a tax return so it starts the tax-return workflow.
5. Select the rows you want and click **Commit**. The files move into their folders in the background. The whole batch is undoable.

## Matching by identifier

Filenames are matched to a client by the client's **External ID** or **AWS ID** (a second identifier some tax-software exports use — see [[creating-clients]]). When the identifier is found, the parsed name is cross-checked against the client name; a low-similarity match is flagged rather than filed silently.

## Routing rules

On the **Rules** tab, build an ordered list of rules. Each rule looks for an identifier string in the filename (contains / starts-with / regex), and points matches at a target folder, optionally adding a year subfolder. Rules are evaluated top to bottom and the first match wins. One rule profile is active per firm.

## Zip import

On the **Import** tab, upload a `.zip` of a client's documents. The app matches the client from the zip's filename, you confirm or change the client and the destination folder, and a worker extracts the archive — preserving its internal folder structure and skipping (never overwriting) duplicates. The upload cap is large (hundreds of MB) to accommodate full exports.

## History and undo

The **History** tab lists each batch with counts of filed and reversed items. You can **undo an entire batch** (everything goes back to the inbox) or **undo a single file**. Undo is logged for the audit trail.

## Tips

- The Document Inbox is separate from the **Files** tab on a client — it's the bulk _routing_ step that feeds those folders. For collecting documents _from_ a client, see [[document-requests]] and [[intake-overview]].
- Set a client's **External ID** / **AWS ID** so the matcher can recognize their documents automatically.
- Executable file types are blocked on upload.
