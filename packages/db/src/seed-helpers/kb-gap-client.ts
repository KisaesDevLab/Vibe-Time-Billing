// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
import { md, type ArticleDef } from './kb-types';

export const CLIENT_GAP_ARTICLES: ArticleDef[] = [
  {
    slug: 'client-payment-methods',
    category: 'client-help',
    title: 'Saved payment methods and autopay',
    summary: 'Save a card or bank, set a default, and turn on autopay for an engagement.',
    tags: ['payment', 'autopay', 'card', 'bank', 'invoices'],
    sortOrder: 70,
    audience: 'both',
    body: md(`
# Saved payment methods and autopay

Open **Payment methods** to manage the cards and bank accounts you've saved, and to choose which engagements pay automatically.

## How to save or remove a payment method
1. The first time you pay an invoice, you can save that card or bank for next time — saved methods then appear under **Saved payment methods**.
2. Each method shows its **Expires** date and a tag like **default**, **enrolled**, or **manual**.
3. To stop using one, select **Remove** next to it.

## How to turn on autopay for an engagement
Autopay is set **per engagement**, under **Which engagements should pay automatically?**:
1. Find the engagement in the list (each row shows the **Engagement**, **Autopay with**, and **State**).
2. Open the dropdown and choose a saved method to **Use for autopay**, or choose **Off (manual pay)** to keep paying by hand.
3. The next time an invoice is created for that engagement, your chosen method is charged automatically.

## Tips
- You'll see a confirmation like "Autopay updated." or "Autopay disabled for this engagement." when you make a change.
- Switch any engagement back to **Off (manual pay)** at any time to go back to paying invoices yourself.
- Your firm never sees your full card number — payments are handled on a secure screen.

Related: [[client-viewing-paying-invoices]], [[client-statement]].
`),
  },
  {
    slug: 'client-statement',
    category: 'client-help',
    title: 'Your account statement',
    summary: 'See lifetime totals and your full invoice history in one place.',
    tags: ['statement', 'account', 'invoices', 'billing', 'history'],
    sortOrder: 80,
    audience: 'both',
    body: md(`
# Your account statement

Open **Statement** for a one-page overview of your account with your firm.

## What you'll see
- **Account totals** at the top:
  - **Billed (lifetime)** — everything your firm has ever billed you.
  - **Paid** — the total you've paid.
  - **Outstanding** — what's still owed.
- **Invoice history** — a table of every invoice, with its **Issued** date, **Due** date, **Total**, amount **Paid**, and **Status** (for example **PAID** or **OVERDUE**).

## Tips
- This is a read-only summary — to actually pay something, open **Invoices**.
- If a number looks off, message your firm and they can explain or correct it.

Related: [[client-viewing-paying-invoices]], [[client-payment-methods]], [[client-messaging-your-firm]].
`),
  },
  {
    slug: 'client-tax-payments',
    category: 'client-help',
    title: 'Estimated tax payments',
    summary: 'View the estimated tax amounts your firm entered and pay online when available.',
    tags: ['tax', 'estimated', 'payments', 'irs', 'due dates'],
    sortOrder: 90,
    audience: 'both',
    body: md(`
# Estimated tax payments

Open **Tax payments** to see the estimated tax obligations your firm has entered for you. These are a helpful, advisory list — they are **estimates entered by your firm**.

## What you'll see
- A **Summary** at a glance: **Upcoming count**, **Total upcoming**, and **Next due**.
- An **Upcoming** list of what's expected and when. Items due soon are highlighted.
- Where your firm has set it up, a **Pay online** link to submit a payment to the tax authority.
- A **Recently paid** section showing payments your firm recorded in the last 90 days.

## Important
Always confirm the amounts with your firm directly **before mailing checks or making payments** to a tax authority. The figures here are estimates, and any receipts or confirmation numbers shown reflect what your firm recorded afterward.

## Tips
- If you expect a payment and don't see one, reach out to your firm — they enter these for you.

Related: [[client-tax-returns]], [[client-messaging-your-firm]], [[client-getting-help]].
`),
  },
  {
    slug: 'client-tax-returns',
    category: 'client-help',
    title: 'Viewing and sharing your tax returns',
    summary: 'Open released returns, read your firm’s note, and share a copy with a 3rd party.',
    tags: ['tax', 'returns', 'share', 'documents', 'review'],
    sortOrder: 100,
    audience: 'both',
    body: md(`
# Viewing and sharing your tax returns

Open **Tax returns** to review the returns your firm has released to you. This page is for **viewing** your returns — you don't sign them here.

## How to view a return
1. Open **Tax returns**. Each row shows the **Year**, **Form**, **Type** (such as **ORIGINAL** or **AMENDED**), **Scope** (**Full** or **Selected sections**), and the date it was **Released**.
2. Select a return to open it. You'll see its **Sections**, the **Document** itself, and any **Note from your firm**.
3. Depending on your firm's settings, the return is either **Download enabled** or **View only**.

## How to share with a 3rd party
If you need to give a lender, bank, or advisor a copy:
1. Open the return and select **Share with a 3rd party**.
2. Enter the recipient's name and email (and optionally their role, organization, and a short message), and set how many days the link should last.
3. Select **Create share link**, then copy the link and send it to them.

The recipient gets a **view-only, watermarked** copy of exactly what was shared with you. You can see each active share and how many times it's been viewed under **Shared with** and **Access history**.

## Tips
- If a return won't open, it may not have been released to you yet — check with your firm.

Related: [[client-tax-payments]], [[client-uploading-documents]], [[client-messaging-your-firm]].
`),
  },
  {
    slug: 'client-updates',
    category: 'client-help',
    title: 'Your updates inbox and notification settings',
    summary:
      'Read in-app notices from your firm and choose how you’re notified by email, SMS, or push.',
    tags: ['updates', 'notices', 'notifications', 'email', 'sms', 'push'],
    sortOrder: 110,
    audience: 'both',
    body: md(`
# Your updates inbox and notification settings

There are two related places: the **Updates** inbox where notices arrive, and **Notification preferences** where you choose how you're alerted.

## Your Updates inbox
Open **Updates** to see notices from your firm about your engagements and account. Unread notices are marked **new**.
- Select **Mark all read** to clear the unread count all at once.
- If it's empty, there's nothing new yet — notices will appear here as your firm posts them.

## Your notification settings
Open **Notification preferences** to control how you're contacted:
1. For each event — like **New invoice posted**, **Payment confirmation**, **Document ready**, or **Monthly statement** — tick **Email**, **SMS**, both, or neither.
2. Select **Save**. Leaving an event unchecked means you won't be notified for it.

You can also turn on **Push notifications** for the device you're using. Push is **per device**, so enable it on each phone or computer you use. On an iPhone or iPad, first add the portal to your Home Screen (Share, then Add to Home Screen), then open it from there to enable push.

## Tips
- Email and SMS choices apply to your account; push is set separately on each device.

Related: [[client-signing-in]], [[client-profile]], [[client-getting-help]].
`),
  },
  {
    slug: 'client-profile',
    category: 'client-help',
    title: 'Your profile and active sessions',
    summary: 'See your account details and active devices, and sign out everywhere else.',
    tags: ['profile', 'account', 'sessions', 'security', 'sign out'],
    sortOrder: 120,
    audience: 'both',
    body: md(`
# Your profile and active sessions

Open **Profile** to see your account details and manage where you're signed in.

## Your identity
Under **Identity** you'll see your **Name**, **Email**, **Phone**, and **Preferred login**. These are managed by your firm — to change your name, primary email, or phone, **contact your firm directly**. You can add backup contact channels under **Alternate contacts**.

## Your active sessions
Under **Active sessions** you'll see every device currently signed in as you, with its **Device**, **IP**, **Last seen**, and when it **Signed in**. The one you're on is tagged **this device**.
- If you see a device you don't recognize, or you signed in somewhere shared, select **Sign out everywhere else** to end every other session.
- To sign out of just the device you're on, use **Sign out** under **This device**.

## Tips
- Signing out everywhere else is a quick way to stay safe after using a public or shared computer.

Related: [[client-signing-in]], [[client-updates]], [[client-getting-help]].
`),
  },
  {
    slug: 'client-engagements',
    category: 'client-help',
    title: 'Tracking your engagements',
    summary: 'Follow the status and progress of the work your firm is doing for you.',
    tags: ['engagements', 'status', 'progress', 'milestones'],
    sortOrder: 130,
    audience: 'both',
    body: md(`
# Tracking your engagements

Open **Engagements** to see the work your firm is doing for you and where each piece stands today. It's a read-only status board — your firm keeps it up to date.

## What you'll see
- Each engagement shows its name, period, and a **status** such as **In progress**, **Awaiting you**, **Scheduled**, **Filed**, **Blocked**, or **Paused**.
- If something needs your attention, you'll see a badge like **3 awaiting you** — that means your firm is waiting on you.
- When milestones are set up, a **progress bar** and **Next milestone** tell you what's coming next, along with the date of the **last activity**.

## Tips
- Seeing **Awaiting you**? Check **Requests** and **Messages** to see what your firm needs.
- All of this is managed by your firm — if a status looks wrong, just message them.

Related: [[client-uploading-documents]], [[client-engagement-letters]], [[client-messaging-your-firm]].
`),
  },
  {
    slug: 'client-engagement-letters',
    category: 'client-help',
    title: 'Reviewing and signing engagement letters',
    summary: 'Read and accept the engagement letters your firm sends you.',
    tags: ['engagement letter', 'sign', 'signature', 'accept', 'terms'],
    sortOrder: 140,
    audience: 'both',
    body: md(`
# Reviewing and signing engagement letters

Open **Letters** to see any **engagement letters awaiting your acceptance** — these set out the terms of the work your firm will do for you.

## How to sign a letter
1. Select **Read** to review the full letter first.
2. When you're ready, select **Accept** to open the signing window.
3. **Draw your signature** in the box (use your finger, stylus, or mouse), and use **Clear** if you want to start over.
4. **Type your full name** to confirm, then select **Accept letter**.

Your acceptance is recorded with the date, your signature, and a few technical details for your records.

## Good to know
- Some letters show **Locked — pay invoice to unlock**. If you see that, pay the related invoice first and the letter will unlock for signing.

## Tips
- Read the whole letter before accepting — it describes what's included and the fees.

Related: [[client-engagements]], [[client-viewing-paying-invoices]], [[client-proposal-signing]].
`),
  },
  {
    slug: 'client-request-access',
    category: 'client-help',
    title: 'Requesting access to your portal',
    summary: 'Ask your firm to set up portal access if you don’t have an account yet.',
    tags: ['access', 'request', 'sign up', 'portal', 'invite'],
    sortOrder: 150,
    audience: 'both',
    body: md(`
# Requesting access to your portal

If you don't have portal access yet, you can ask your firm to set it up. On the sign-in screen, choose **Request access** (the page is titled "Request access").

## How to request access
1. Enter your **Email or phone** — use the contact details your firm has on file for you.
2. Under **Verify your identity**, choose **Individual** or **Business**:
   - **Individual** — enter the **last 4 digits of your SSN**.
   - **Business** — enter the **last 4 digits of your EIN**.
3. Select **Request access**.

You'll see a "Request received" confirmation. Your firm reviews each request, and if your details match their records, they'll grant access and follow up by email or text.

## Tips
- Already have access? Use **Sign in** instead.
- Use the same email or phone your firm already has for you — that helps them match your request quickly.

Related: [[client-signing-in]], [[client-getting-help]].
`),
  },
  {
    slug: 'client-proposal-signing',
    category: 'client-help',
    title: 'Reviewing and signing a proposal',
    summary: 'Open a proposal link, pick a package, and e-sign to accept.',
    tags: ['proposal', 'sign', 'accept', 'package', 'engagement'],
    sortOrder: 160,
    audience: 'both',
    body: md(`
# Reviewing and signing a proposal

When your firm sends you a proposal, you'll get a link by email. Open it to review the proposal and accept it online — no sign-in needed.

## How to accept a proposal
1. Read through the proposal and terms.
2. If options are offered, **Choose a package** — the one you pick shows a **Selected** tag, and a suggested option may be marked **Recommended**.
3. Under **Sign to accept**, enter **Your name** and **Your email**, then **type your full name to sign**.
4. Select **Accept proposal**.

You'll see a "Thank you" confirmation with a signature reference, and your firm will follow up with next steps.

## If more than one person signs
Some proposals need several signers. If so, you'll see where you fall in the order and a roster showing who's **SIGNED**. After you sign, the next person gets their own link.

## Tips
- Links can expire — if yours says it's expired or out of date, ask your firm for a fresh one.
- Need help? Reply to the email that contained your link, or contact your firm directly.

Related: [[client-engagement-letters]], [[client-retainers]], [[client-getting-help]].
`),
  },
  {
    slug: 'client-retainers',
    category: 'client-help',
    title: 'Your retainers and retainer offers',
    summary: 'Track your retainer hours and balance, and respond to a retainer offer.',
    tags: ['retainer', 'hours', 'balance', 'offer', 'representation'],
    sortOrder: 170,
    audience: 'both',
    body: md(`
# Your retainers and retainer offers

A retainer is prepaid coverage — for example, a block of representation hours. Open **Retainers** to see the ones you hold and how much is left.

## Checking your retainer balance
Each retainer shows its **Coverage**, the related **Return**, **Hours remaining** (such as "5.50 / 20.00"), the **Expires** date, and a **Status** like active, exhausted, or expired.
- Select **Activity** on a retainer to see its ledger — each time hours are added or used, it's listed with the **Date**, **Type**, **Hours**, and **Remaining** balance.

## Responding to a retainer offer
If your firm offers you a new retainer, you'll get a link to review it. On the offer page you can:
1. Select the option you want (the chosen tier shows a **Selected** tag).
2. Then choose how to proceed:
   - **Pay online now** — pay right away and your coverage activates once payment clears.
   - **I'll pay at the office** — reserves your selection so you can pay by cash or check in person (you can still pay online later).
   - **No thanks** — decline the offer.

You can also use **Print / Download PDF** to keep a copy of the offer.

## Tips
- Offers can expire — the page shows how many days you have left to respond.

Related: [[client-proposal-signing]], [[client-viewing-paying-invoices]], [[client-getting-help]].
`),
  },
];
