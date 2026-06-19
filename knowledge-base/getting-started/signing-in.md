---
title: 'Signing in: magic link, password, or passkey'
slug: signing-in
category: getting-started
audience: staff
tags: ['login', 'auth', 'sign-in', '2fa', 'password', 'magic link']
---

# Signing in

The staff app offers three sign-in methods, shown as buttons at the top of the **Sign in** screen: **Magic link**, **Password**, and **Passkey**. Pick whichever your account is set up for.

## Steps

1. Go to the sign-in page (`/auth/login`). You'll see the **Sign in** heading.
2. Choose **Magic link**, **Password**, or **Passkey**.
3. Magic link: enter your **Email**, click **Send sign-in link**, then open the email and click through to complete sign-in.
4. Password: enter your **Email** and **Password**, click **Continue**, then complete the second-factor challenge (see _Two-factor_).
5. Passkey: click **Use a passkey**; your browser prompts you to pick a passkey and verify with your device's biometric or PIN. No email or password needed.

## What you'll see

- After requesting a magic link: "If your account exists, a sign-in code has been sent. Check your email." This same message appears whether or not the email matches an account — the app deliberately doesn't reveal whether an account exists (account-enumeration mitigation).
- The magic-link email opens a **Confirm sign-in** screen; click **Continue** to finish.
- Password sign-in is followed by a second-factor step unless you used a passkey as your primary method.

## Tips

- Don't have a password yet? Sign in with **Magic link**, then set one from your profile (**Account**).
- No passkey yet? Sign in by magic link or password first, then add one from **Account**.
- A wrong password shows "Email or password is incorrect." After too many attempts you may be rate-limited ("Too many attempts. Try again in a few minutes.").
