---
title: 'Client folder templates (admin)'
slug: folder-templates-admin
category: files
audience: staff
tags: ['files', 'folders', 'templates', 'visibility', 'admin']
---

# Client folder templates (admin)

A folder template is a firm-level, ordered list of folders that the Files tab shows under every client's root (they stay empty until used). **Admin → Folder templates** is where you build those templates, set per-folder visibility, reorder them, and pick which one is the firm default. The default template applies to any client that hasn't been assigned a specific template.

## Who can do this

Staff with **`firm:settings:write`** can create, edit, reorder, and delete; without it the page is read-only.

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
