---
title: 'Signing a proposal with OpenSign'
slug: opensign-signing
category: proposals
audience: staff
tags: ['opensign', 'e-sign', 'signature', 'proposals', 'portal']
---

# Signing a proposal with OpenSign

When the firm's e-sign provider is **OpenSign**, sending a proposal works exactly as usual — the difference is where and how the client signs. Vibe keeps ownership of the brochure, package selection, and any Stripe ACH mandate; OpenSign handles only the signature.

## Steps

1. Build and **Send** the proposal as normal (define the signer roster + order; see _Building and sending proposals_ and the multi-signer notes).
2. The client opens their **portal magic link** and reviews the proposal, selects a package, and confirms payment details **in the Vibe portal**.
3. When the client clicks **Sign**, the portal calls the OpenSign "start signing" step and **redirects the browser to OpenSign's signing UI** (URL of the form `<opensign>/load/recipientSignPdf/<documentId>/<contactId>`).
4. The client signs in OpenSign. On completion OpenSign sends a **signed webhook** back to the appliance; if that's ever missed, a worker **poll runs every ~2 minutes** as a safety net.
5. The appliance records the signature: the signer row flips to **SIGNED**, and the **signed PDF + certificate** are fetched from OpenSign and stored in the firm's own object storage (under `opensign-certs/…`).
6. Once **all required signers** have completed (parallel or sequential), the proposal flips to **ACCEPTED** and the engagement scope is frozen — exactly once.

## What you'll see

- In **sequential** mode, the next signer's link is issued only after the prior signer completes; in **parallel** mode all signers can sign in any order.
- A **declined** signer (in OpenSign) sets that signer's row to **DECLINED** and moves the proposal to **IN_PROGRESS** (staff-recoverable — you can replace/re-invite that signer).
- Mixed rosters work: some signers can be native and some OpenSign on the same proposal; the proposal only completes when every required signer is done.

## Tips

- The signing URL is reached **through the portal**, not emailed raw — so the client always passes through the Vibe brochure/package/payment step first.
- The certificate and signed PDF live in **your** storage, not OpenSign's — OpenSign never receives your storage credentials.
- If a signature seems stuck after the client signed, the poll will reconcile it within a couple of minutes; see _OpenSign signing isn't completing_.
