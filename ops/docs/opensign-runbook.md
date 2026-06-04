# OpenSign e-signature — deploy runbook

OpenSign is an **optional** e-signature backend, offered as a per-firm
alternative to the built-in **native** HMAC e-sign provider (which is the
default and needs no setup). OpenSign is **AGPL-3.0** and is therefore run
strictly as **unmodified upstream containers** on their **own private
network**, reached over HTTP only — see `LICENSING.md` for the boundary.
The appliance core never imports, bundles, or links OpenSign source.

Until you complete all of these steps, every firm stays on native e-sign
(the `opensign` option is hidden in admin and the per-firm setting falls
back to native with a logged warning even if mis-set).

## Reality check (self-host ≠ SaaS)

The self-hosted OpenSign API is **Parse Server cloud functions**, NOT the
hosted SaaS REST API. There is **no** `/api/v1.2/*` layer and **no**
`x-api-token`. Server-to-server auth is the **Parse header pair**:

```
X-Parse-Application-Id: opensign
X-Parse-Master-Key: <MASTER_KEY>
```

Cloud functions are invoked as `POST {base}/functions/<fn>` with those
headers and a JSON body; the response is `{ "result": ... }`.

Some write-path functions require a **user session** (`request.user`), not
just the master key, so the integration also needs an OpenSign **API
account** whose credentials mint a session token via the `loginuser`
function. See "Cloud-function contract" below.

## Deployment topology

OpenSign is deployed **standalone**, NOT as a service in the appliance
compose. The real upstream stack is **four** services:

| Service | Image | Notes |
|---|---|---|
| `opensign-server` | `opensign/opensignserver:main` | Parse Server + cloud functions (port 8080) |
| `opensign-client` | `opensign/opensign:main` | React signing UI |
| `opensign-mongo`  | `mongo:7` | OpenSign's datastore |
| `opensign-caddy`  | `caddy:2-alpine` | TLS ingress, serves UI + proxies `/api/*` |

> The single-image `opensignlabs/opensign:v2.4.4` referenced by older
> drafts **does not exist** — ignore it.

Compose + config live in `ops/docker/opensign/`
(`docker-compose.yml`, `Caddyfile`, `.env.prod` — gitignored, holds
`APP_ID`, `MASTER_KEY`, `PUBLIC_URL`, storage mode, the signing PFX).

```bash
docker compose -f ops/docker/opensign/docker-compose.yml \
  --env-file ops/docker/opensign/.env.prod up -d
# UI:  https://localhost:4001              (self-signed cert)
# API: https://localhost:4001/api/app      (caddy)  or  http://opensign-server:8080/app  (in-network)
```

The appliance `api`/`worker` reach OpenSign over `OPENSIGN_URL`. On
completion OpenSign POSTs a signed webhook to
`https://<appliance>/api/webhooks/opensign`; the worker `opensign-poll`
job (every 2 min) is a safety net if a webhook is missed. OpenSign is
**never** given our object-store credentials — on completion the API
fetches the signed/certificate PDF and stores it in OUR bucket
(`opensign-certs/<firmId>/<proposalId>/<signatureId>.pdf`).

## Cloud-function contract (verified live against v2.37.0)

| Step | Function | Auth | Key params | Returns |
|---|---|---|---|---|
| login (mint session) | `loginuser` | master key | `email`, `password` | `_User` JSON incl. `sessionToken`, `objectId` |
| resolve ExtUser | `getUserDetails` | master key | `email` | `{ objectId }` of `contracts_Users` |
| upload PDF | `savefile` | **session** | `fileBase64`, `fileName` | `{ url }` |
| create signer | `savecontact` | **session** | `name`, `email` | contact JSON (`objectId`) |
| create + send doc | `createdocumentfromapp` | **session** | `document` (incl. `URL`, `ExtUserPtr`, `CreatedBy`, `Signers[]`, `SentToOthers`) | document JSON (`objectId`) |
| status | `getDocument` | master key | `docId` | document JSON (`IsCompleted`, `IsDeclined`, `SignedUrl`, `CertificateUrl`, `AuditTrail`, `Signers`) |
| certificate | `generatecertificate` | master key | `docId` | `{ CertificateUrl }` |

The per-signer **signing URL** is the OpenSign UI route (verified in
`apps/OpenSign/src/App.jsx`):

```
${PUBLIC_URL}/load/recipientSignPdf/<docId>/<contactBookId>
```

Our provider (`apps/api/src/esign/provider.ts`) implements exactly this
flow and caches the session token + the ExtUser/CreatedBy pointers.

## Steps

1. **Stand up OpenSign** (see "Deployment topology" above) and note the
   `APP_ID` + `MASTER_KEY` from `ops/docker/opensign/.env.prod`.

2. **Create an OpenSign API account.** Sign up a user in the OpenSign UI
   (`https://localhost:4001`) — this becomes the document owner. Note its
   email + password.

3. **Mint the webhook Security Key.** In the OpenSign UI: **Settings →
   Webhook**, generate the 64-char **Webhook Security Key**, and register
   the webhook URL `https://<appliance>/api/webhooks/opensign` with the
   events `created/viewed/signed/completed/declined`. OpenSign signs each
   delivery with HMAC-SHA256 of the raw body in header
   **`x-webhook-signature`**.

4. **Set env** in the appliance `.env` (read by both `api` and `worker`):

   ```bash
   OPENSIGN_URL=https://<opensign-host>:4001/api/app   # or http://opensign-server:8080/app in-network
   OPENSIGN_APP_ID=opensign
   OPENSIGN_MASTER_KEY=<MASTER_KEY from .env.prod>
   OPENSIGN_PUBLIC_URL=https://<opensign-host>:4001     # for signer URLs (defaults: derived from OPENSIGN_URL)
   OPENSIGN_API_EMAIL=<API account email>
   OPENSIGN_API_PASSWORD=<API account password>
   OPENSIGN_WEBHOOK_SECRET=<Webhook Security Key>
   ```

   Setting `OPENSIGN_URL` is what makes the per-firm `opensign` provider
   *selectable* in admin; absent → native is always used. Restart
   `api`/`worker` to pick up the env.

   > If both stacks run on one host, either reach the caddy URL
   > (`https://host.docker.internal:4001/api/app`) or attach `api`/`worker`
   > to the external `opensign-net` network and use
   > `http://opensign-server:8080/app`.

5. **Flip the firm to OpenSign.** Staff app: **Admin → Firm settings →
   E-sign provider** → **OpenSign**, Save. The option is only enabled when
   `OPENSIGN_URL` is configured (`openSignAvailable`). Native stays the
   default.

6. **Verify a round-trip.** Send a proposal, open the portal link, use the
   **Sign** action — the portal redirects to the OpenSign signing UI. After
   signing, confirm:
   - the webhook lands (api logs: `opensign webhook … completed`),
   - the signature row flips to `SIGNED` with `opensign_certificate_object_key`,
   - the cert PDF exists in object storage under `opensign-certs/…`,
   - for the last required signer, the proposal flips to `ACCEPTED` and an engagement is frozen.
   If the webhook is blocked, the worker `opensign-poll` job advances the
   same state within ~2 minutes (idempotent — no double freeze).

## Notes & risks

- **Security:** the webhook is unauthenticated by session — the only gate
  is the HMAC (`x-webhook-signature`, constant-time compared) + document-id
  ownership + idempotency (`opensign_webhook_events`, keyed on a
  synthesized `objectId:event:disc`). Keep the Webhook Security Key and the
  master key secret; rotate together.
- **Portal-first delivery:** our portal still owns the brochure, package
  selection, and the Stripe ACH SetupIntent. OpenSign only handles the
  signature; the signing URL is reached *through* the portal. SEQUENTIAL
  multi-signer still emails the portal magic link to the next signer.
- **Multi-signer × OpenSign:** mixed native + OpenSign rosters work; the
  proposal `FOR UPDATE` lock serializes completions so ACCEPTED + freeze
  fire exactly once when all required signers are done.
- **AGPL containment:** never add an OpenSign client SDK to
  `package.json`/`pnpm-lock.yaml` and never `build:` OpenSign from source —
  that would breach the license boundary and the CI license-check. It stays
  an `image:`-only network peer behind its own compose.
- **SMTP:** the eval `.env.prod` disables SMTP. Enable + point at a mail
  provider before relying on OpenSign's own signer emails (we drive signing
  through the portal, so this is only needed for OpenSign-side reminders).
- **Resource cost:** OpenSign (4 services + MongoDB) adds meaningful
  memory/disk; size the host accordingly before enabling.

## Disabling

Set the firm back to **Native** in admin, then stop the standalone stack:

```bash
docker compose -f ops/docker/opensign/docker-compose.yml down
```

In-flight OpenSign documents stop advancing; re-send affected proposals on
native if needed. Unsetting `OPENSIGN_URL` hides the option again and
forces native for all firms.
