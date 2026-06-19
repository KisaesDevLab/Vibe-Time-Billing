---
title: 'Setting up payment processing'
slug: payment-setup
category: payments
audience: staff
tags: ['payments', 'stripe', 'cpacharge', 'setup']
---

# Setting up payment processing

Vibe is firm-owned: your firm supplies its own Stripe credentials and Stripe is the live processor. (CPACharge is scaffolded but not yet active — firm settings report it disabled.)

## Steps

1. **Set the Stripe keys on the appliance.** Stripe credentials are read from environment variables on the API container, not a settings form: `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`. An operator sets them and restarts the API.
2. Go to **Admin → Firm settings → Billing and A/R**. Under **A/R options**, tick **Enable credit card processing** (lets staff charge cards on the Receive Payment page) and/or **Enable ACH processing**. Click **Save**.
3. (Optional, for proposals/recurring) **Admin → Stripe Connect** → **Connect Stripe** to link an account via OAuth.
4. To pass processor fees to a client, open the engagement, **Edit**, and turn on **Fee passthrough** ("Add processing fee line item on invoices").

## What you'll see

On **Admin → Stripe Connect**: if platform credentials aren't set, a **Not configured** pill (set `STRIPE_CONNECT_CLIENT_ID` + `STRIPE_SECRET_KEY` and restart); once connected, a **Connected account** card with **Refresh from Stripe** / **Disconnect** and a **Capabilities** card (Charges / Payouts / Details).

## Tips

- Keys live in the appliance environment so credentials never pass through the browser — hand this to whoever manages the appliance.
- The Receive Payment "Charge" mode is enabled only when Stripe is wired **and** credit card processing is on.
