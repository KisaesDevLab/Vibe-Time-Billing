---
title: 'Setting up two-factor authentication'
slug: two-factor
category: getting-started
audience: staff
tags: ['2fa', 'totp', 'passkey', 'security', 'mfa']
---

# Two-factor / second factor

Every staff user must have at least one second factor enrolled. The supported factors are passkey (WebAuthn), authenticator app (TOTP), email code, and text message (SMS). After a password or magic-link sign-in you'll be challenged for one of these; a passkey used as the primary sign-in method counts as the factor on its own.

## Steps

1. Open **Account** from the left nav.
2. Authenticator app: in **Two-factor (TOTP)** click **Generate new enrollment**, or use the enrollment screen which shows a QR code to scan, then enter the **6-digit code from your authenticator** and click **Verify & finish**.
3. Passkey: in the **Passkeys** card click **Add a passkey**, complete the browser prompt, and name it when asked.
4. Email code: in **Sign-in settings** under **Second factor**, on the **Email code** row click **Enable**.
5. Text message (SMS): on the **Text message (SMS)** row enter your number (format `+15551234567`), click **Send code**, then enter the texted code and click **Verify**.
6. Optionally click **Set preferred** on a factor so it's offered first at sign-in.

## What you'll see at sign-in

- If you have more than one factor, a **Choose your second factor** picker appears with buttons labeled **Authenticator app**, **Email code**, **Text message**, and **Passkey**.
- **Authenticator app**: enter the current code, then click **Sign in**.
- **Email code** / **Text message**: a code is sent automatically; the screen shows where it went, with a **Resend** button.
- **Passkey**: click **Use passkey** and confirm on your device.

## Recovery codes

- Recovery codes are generated when you enroll TOTP and are shown only once, under **Recovery codes (save now)**. Save them somewhere safe — check **I have saved these codes** before finishing.

## Firm-wide requirement (admin)

By default the firm **requires** every staff member to enroll a second factor. An administrator can turn this requirement off in **Admin → Firm settings** for a fully internal deployment — with it off, password sign-in issues a session without a second-factor challenge and sensitive actions skip the step-up gate. Leaving it on is strongly recommended for any internet-reachable appliance. Turning it off doesn't remove factors staff have already enrolled.

## Tips

- Step-up re-prompt: sensitive actions re-challenge your second factor only if it's been more than 30 minutes since your last verification. **Account** shows **Step-up last verified**.
- A successful passkey verification also counts as step-up. Use **Verify a passkey now** on the **Account** page to refresh step-up on demand.
- Passkey is the strongest factor and is auto-preferred at sign-in when registered.
