---
title: 'Files & storage'
slug: files-overview
category: files
audience: staff
tags: ['files', 'storage', 'b2', 'minio']
---

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

- **Provider** — `mock`, `b2`, or `minio`. `mock` writes to the appliance's local filesystem under `/data/storage-mock`.
- **Endpoint** / **Region** / **Bucket** — the S3-compatible target.
- **Key ID** + **Application Key** (B2) or **Access key** + **Secret key** (MinIO). Secrets are masked once saved; the stored value shows as `(saved · …)` and the secret field shows `(saved — leave blank to keep)`.

## What you'll see

- A warning banner after save: "Restart the appliance" for the new provider to take effect; existing uploads do not auto-migrate.
- A **Test connection** result line: `Connection OK · <ms>` or `Connection failed: <error>`.
- A **Last tested …** line showing the timestamp and tested provider.
- In the client **Files** tab: a **Storage folder** card (path, status, **Last synced**, **Refresh**, **Rename folder**), a collapsible **folder tree** on the left, and a file table on the right. Files mid-upload show a `pending` pill.

## Working in the Files tab

- Click a folder in the tree to filter the table to it; search by filename and filter by visibility.
- Each file row has icon actions — **share**, **flag** (as a tax return), **preview** (PDFs), and **download** — plus a click-to-toggle visibility pill.
- **Select multiple files** (or use select-all) to make them client-visible / private in bulk, or to share them together as one access-code link. See [[gated-share-links]].
- The **folder template** selector sets which standard folders the client starts with — see [[folder-templates]].

## Tips

- Credentials are sealed with the firm key before they hit the database, so a DB dump never leaks them.
- Re-type the masked Key ID / access key to save changes; leaving the masked hint in place blocks the save.
- `mock` is fine for dev or a single host; choose B2 or MinIO for production durability.
- Saving credentials never migrates files already stored on the previous provider.
- To get many documents into client folders at once, use the [[document-inbox]] rather than uploading one by one.
