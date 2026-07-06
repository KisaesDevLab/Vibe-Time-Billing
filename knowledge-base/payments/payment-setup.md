---
title: 'Setting up payment processing (Stripe Connect + webhooks)'
slug: payment-setup
category: payments
audience: staff
tags: ['payments', 'stripe', 'stripe-connect', 'webhook', 'setup', 'ach', 'cards']
---

# Setting up payment processing (Stripe Connect + webhooks)

Vibe is firm-owned: **your firm supplies its own Stripe account and keys**, and Stripe is the live processor. Kisaes never holds your credentials. (CPACharge is scaffolded but not active.)

Setting up payments is **three parts**: (1) connect your Stripe account, (2) turn on card/ACH, and (3) **configure the Stripe webhook** — the webhook is what actually records a payment against an invoice. Skipping the webhook is the #1 setup mistake: cards will charge in Stripe but invoices will never show paid.

---

## 1. Connect your Stripe account

You can connect Stripe **either** way — pick one:

### Option A — Direct keys (recommended, simplest)

Paste your own Stripe API keys into the app.

1. In Stripe, switch to the mode you want (**Test mode** toggle, top-right — use Test first). Go to **Developers → API keys**.
2. Copy the **Secret key** (`sk_test_…` / `sk_live_…`) and **Publishable key** (`pk_test_…` / `pk_live_…`).
3. In Vibe: **Admin → Billing → Stripe Connect** (or **Admin → Firm settings → Billing**) → paste the **Secret key** and **Publishable key** → **Save**. They're encrypted at rest.

The secret key already scopes to your account, so no "connected account id" is needed.

### Option B — Connect OAuth (Standard)

For operators who run a Stripe platform: **Admin → Stripe Connect → Connect Stripe** links your account via OAuth. This requires the operator to have set `STRIPE_CONNECT_CLIENT_ID` (+ the platform `STRIPE_SECRET_KEY`) on the appliance. If you don't see the button, the platform isn't configured — use Option A.

### Appliance env vars (operator alternative)

Instead of the Admin form, an operator can set these on the API container and restart:

| Variable                        | What it is                                     |
| ------------------------------- | ---------------------------------------------- |
| `STRIPE_SECRET_KEY`             | Secret key (`sk_…`)                            |
| `STRIPE_PUBLISHABLE_KEY`        | Publishable key (`pk_…`)                       |
| `STRIPE_WEBHOOK_SECRET`         | **Webhook signing secret (see part 3)**        |
| `STRIPE_CONNECT_CLIENT_ID`      | (Option B only) platform Connect client id     |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | (Option B only) Connect webhook signing secret |

Keys never pass through the browser — hand env setup to whoever manages the appliance.

---

## 2. Turn on card / ACH

**Admin → Firm settings → Billing and A/R → A/R options:** tick **Enable credit card processing** and/or **Enable ACH processing**, then **Save**. The Receive Payment "Charge" mode, pay-by-link, saved cards, and recurring payment plans all require this on **and** Stripe wired.

- **ACH** (bank debit) is cheaper and has no card expiry — preferred for recurring billing. ACH settles over a few days and can **return** later (see [ACH returns](ach-returns)).
- To pass processor fees to a client: open the engagement → **Edit** → **Fee passthrough**.

---

## 3. Configure the Stripe webhook (required)

The webhook is how Stripe tells Vibe a payment succeeded/failed so the invoice ledger updates. **Everything that collects money depends on it:** pay-by-link, Receive Payment "Charge", saved-card / recurring payment plans, refunds, disputes, and ACH returns. Without it, charges succeed in Stripe but invoices stay unpaid.

### Create the endpoint

1. In Stripe: **Developers → Webhooks → Add endpoint** (make sure you're in the same mode — Test or Live — as your keys).
2. **Endpoint URL:** `https://<your-app-domain>/api/webhooks/stripe`
   - Use your **staff app** domain (e.g. `https://app.yourfirm.com/api/webhooks/stripe`). It must be reachable from the public internet.
   - **Option B / Connect OAuth only:** _also_ add a second endpoint `https://<your-app-domain>/api/webhooks/stripe-connect` and, in Stripe, set it to listen to **"Events on Connected accounts"**. Its signing secret goes in `STRIPE_CONNECT_WEBHOOK_SECRET`.
3. **Select events to send.** At minimum:
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
   - `charge.succeeded`
   - `charge.failed`
   - `charge.refunded`
   - `charge.dispute.created`
   - `charge.dispute.closed`
   - `checkout.session.completed`
     (Selecting "all events" also works; the app ignores ones it doesn't use.)
4. **Add endpoint**, then open it and **reveal the Signing secret** (`whsec_…`).
5. Put that secret in Vibe: the **Webhook signing secret** field on **Admin → Billing → Stripe Connect** (or set `STRIPE_WEBHOOK_SECRET` on the appliance and restart the API). This is used to verify each event's signature — an unset or wrong secret makes the app reject every event.

### Verify it works

- **Test mode, quickest:** with the [Stripe CLI](https://stripe.com/docs/stripe-cli): `stripe listen --forward-to https://<your-app-domain>/api/webhooks/stripe` then `stripe trigger payment_intent.succeeded`. The CLI prints the events; the app should return `200`.
- **Or:** take a real test payment (pay-by-link or Receive Payment with test card `4242 4242 4242 4242`) and confirm the invoice flips to **Paid** and a **Payment received** row appears. If the charge shows in the Stripe Dashboard but the invoice is still unpaid, the webhook isn't reaching the app — re-check the URL and signing secret.
- In Stripe → Webhooks → your endpoint, the **Recent deliveries** list shows `200` (success) or the error body for each attempt.

---

## Troubleshooting

- **Charge succeeds in Stripe but invoice stays unpaid** → webhook not configured / wrong URL / wrong signing secret / app not publicly reachable. This is the most common issue.
- **Every webhook returns 400 (signature)** → the `whsec_…` secret in Vibe doesn't match the endpoint's signing secret, or Test/Live modes are mismatched.
- **`collect_failed` / "Requires Stripe Connect to be set up"** → keys not saved, or A/R card/ACH toggle off.
- **Recurring plan / saved card can't charge** → the saved method or Stripe customer wasn't created (Stripe not wired at save time), or the webhook isn't delivering so charges never settle.
- Keep **Test** and **Live** fully separate: test keys + test webhook secret together, live keys + live webhook secret together.
