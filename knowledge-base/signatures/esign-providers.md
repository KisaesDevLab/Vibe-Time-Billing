---
title: 'E-signatures: native vs OpenSign'
slug: esign-providers
category: signatures
audience: staff
tags: ['e-sign', 'signature', 'opensign', 'native', 'proposals']
---

# E-signatures: native vs OpenSign

Proposals are signed electronically. The firm chooses one of two e-signature backends in **Admin → Firm settings → E-sign provider**:

- **Native** (default) — the built-in signer. The client signs **inside the Vibe client portal** (typed name or drawn signature). Each signature is sealed with a per-firm HMAC and is independently verifiable. No setup, no extra services.
- **OpenSign** (optional) — an external open-source e-signature service run as an isolated sidecar. The client signs in **OpenSign's own signing UI**, which produces a signed PDF + a completion certificate. Richer signing experience, at the cost of running and configuring the OpenSign stack.

## How they differ

- **Where signing happens:** native = the Vibe portal; OpenSign = OpenSign's UI (the portal redirects the signer there).
- **Completion:** native is synchronous (the signature lands as the client submits); OpenSign is asynchronous — OpenSign notifies the appliance via a signed webhook (with a worker poll as a safety net), then the signature is recorded.
- **Setup:** native needs none; OpenSign requires standing up the sidecar and configuring it (see _Enabling OpenSign e-signatures_).
- **Artifacts:** OpenSign additionally stores a signed PDF + certificate in the firm's own object storage.

## What you'll see

- The **E-sign provider** selector in firm settings only enables the **OpenSign** option when OpenSign is configured on the appliance (`OPENSIGN_URL` set). Until then it stays on **Native** and any mis-set value falls back to native with a logged warning.
- The signer roster, signing order (parallel/sequential), and the all-required-signers gating that flips a proposal to **ACCEPTED** and freezes the engagement work the same way under **both** providers — including mixed rosters.

## Tips

- Native is the right choice for most firms — it's legally binding, verifiable, and zero-maintenance.
- Pick OpenSign only if you specifically want OpenSign's signing UI / certificate workflow and are willing to run the sidecar.
- Switching the provider only affects **new** signing sessions; in-flight signatures keep their original backend.
