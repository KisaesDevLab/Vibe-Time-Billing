# Licensing

This document explains the licensing model of the Vibe Time & Billing
appliance and, in particular, how the optional OpenSign e-signature
integration stays compliant with OpenSign's AGPL-3.0 license without
infecting the appliance core.

## Appliance core — PolyForm Small Business License 1.0.0

The Vibe Time & Billing appliance (everything under `apps/`, `packages/`,
`ops/`, `seed/`, and the built container image published to GHCR) is
licensed under **PolyForm Small Business License 1.0.0** (see `LICENSE.md`). Every
source file carries the SPDX header `PolyForm-Small-Business-1.0.0`.

The CI license-check **must continue to find zero AGPL or GPL
dependencies** in `package.json` / the lockfile. OpenSign is **not** a
dependency — it never enters `package.json`, the pnpm lockfile, or the
appliance image. See "OpenSign" below for why that is structurally true.

## Native e-signature is the default

The appliance ships a first-party, self-contained e-signature provider
("native" — typed name + sanitized drawn SVG, with a per-firm HMAC over
the signed record as the proof of acceptance). **Native is the default
e-sign provider for every firm.** No third party is involved and no
AGPL/GPL code is reached.

## OpenSign — AGPL-3.0, included only as an isolated network peer

OpenSign (https://github.com/OpenSignLabs/OpenSign) is licensed under
**AGPL-3.0**. It is supported as an **optional**, **per-firm opt-in**,
**off-by-default** e-signature provider, subject to the following hard
constraints that keep it isolated from the PolyForm-licensed appliance core:

1. **No source import.** None of OpenSign's source code is copied,
   vendored, or imported into this repository.
2. **No static link / no bundle.** OpenSign is not linked into, bundled
   with, or compiled into the appliance image. It is not a `package.json`
   dependency and never appears in the lockfile.
3. **Unmodified, upstream container images only.** OpenSign runs
   exclusively as the **unmodified** official upstream images
   (`opensign/opensignserver`, `opensign/opensign`, plus `mongo` and
   `caddy`) — the real self-host topology, deployed **standalone** via
   `ops/docker/opensign/docker-compose.yml` on its own private network
   (`opensign-net`). It is **not** a service in the appliance compose, and
   there is no `build:` directive pointing at our tree for any of it.
   (The single-image `opensignlabs/opensign` referenced by older drafts
   does not exist.)
4. **Reached over HTTP on a separate network.** Our API talks to OpenSign
   only over HTTP (its Parse Server API) — a clean network boundary /
   "mere aggregation" (the AGPL covers the OpenSign process, not our
   separately-licensed process that calls it). The client lives in
   `apps/api/src/esign/provider.ts` (`createOpenSignProvider`) and speaks
   OpenSign's **Parse cloud-function** API (`X-Parse-Application-Id` +
   `X-Parse-Master-Key`/session token); it imports nothing from OpenSign.
   Note: the self-hosted API is Parse Server cloud functions — there is
   **no** SaaS REST layer (`/api/v1.2`, `x-api-token`) on self-host.
5. **Separate deploy + off by default.** Because OpenSign is its own
   standalone compose, a normal appliance `docker compose up` never starts
   it. An operator must stand up the standalone stack **and** set
   `OPENSIGN_URL` (+ `OPENSIGN_APP_ID`/`OPENSIGN_MASTER_KEY`,
   `OPENSIGN_API_*`, and the UI-minted webhook key), then opt in per-firm
   in admin settings, before any OpenSign code path runs.
6. **No appliance credentials cross the boundary.** OpenSign is never
   given our object-store credentials. On completion, our API fetches the
   signed/certificate PDF from OpenSign and stores it in **our** storage
   (`opensign-certs/<firmId>/<proposalId>/<signatureId>.pdf`). The
   completion signal is OpenSign's HMAC-signed webhook
   (`x-webhook-signature`, secret minted in the OpenSign UI).

### Operator obligations under AGPL

If you (the operator) enable OpenSign and your users interact with it over
a network, AGPL-3.0 requires that those users be able to obtain the
**complete corresponding source** of the OpenSign instance you run.
Because it runs as the **unmodified** upstream images, that obligation is
satisfied by OpenSign's own published source
(https://github.com/OpenSignLabs/OpenSign). Do not modify the images; if
you do, you must offer your modified source to its users yourself. The
PolyForm-licensed appliance core is a separate program reached over the
network and is not a derivative work of OpenSign.
