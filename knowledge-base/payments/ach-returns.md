---
title: 'ACH returns'
slug: ach-returns
category: payments
audience: staff
tags: ['ach', 'returns', 'nacha', 'mandate', 'disputes']
---

# ACH returns

An **ACH return** is the bank's notice that an ACH debit you collected didn't clear — the client's bank pulled the money back. Common reasons are insufficient funds, a closed account, or the account holder saying they never authorized it. Late-failure _disputes_ (a chargeback-style claim after settlement) also land here. Find them on the **ACH returns** tab of `/payments`.

## Who can do this

Staff with payments access can view the ACH returns dashboard. It is read-only — the side effects are applied automatically when the return arrives; there's nothing to approve here.

## Steps

1. Open **Payments → ACH returns**.
2. The summary shows the count of **Returns** and the total **Returned amount**.
3. Each row shows the date, client, invoice, the NACHA **Code**, the **Category**, amount, **Type** (Return vs Late dispute), and the **Action taken**.
4. Click **View** on a row to open the related invoice and collect again or follow up with the client.

## Field reference

- **Code** — the raw NACHA return code (e.g. R01, R10).
- **Category** — INSUFFICIENT FUNDS, NO AUTHORIZATION, ACCOUNT ERROR, or OTHER.
- **Action taken** —
  - **retriable** — the debit can be safely retried (typically insufficient funds).
  - **mandate voided** — the client's ACH authorization was invalidated; they must re-authorize before any further debit, and autopay on that bank account is paused automatically.
  - **bank blocked** — that payment method is blocked from future use.
  - **halted** — none of the above; the collection simply stopped.

## Common errors

- **Why was autopay paused?** — a "mandate voided" return (often a NO AUTHORIZATION code) automatically invalidates the mandate; the client must re-authorize ACH in the portal.
- **A retriable return reappears** — repeated insufficient-funds returns mean you should contact the client rather than keep retrying.

Related: [[payments-list]] [[payment-setup]] [[recording-payments]]
