---
title: "I can't sign in / it returns to the sign-in screen"
slug: login-loops
category: troubleshooting
audience: staff
tags: ['troubleshooting', 'login', '403', 'cookie']
---

# Login keeps returning to the sign-in page

You enter your email (or password + code), the page reloads, and you land back on the sign-in screen as if nothing happened. In almost every case this is a cookie problem, not a password problem: the browser is refusing to keep the session cookie the server set.

## Symptoms

- After a successful sign-in the app immediately bounces back to the login page.
- You can request a magic link or sign-in code and it works, but the dashboard never "sticks."
- The loop happens on a specific URL (often a bare LAN IP or an `http://` address) but not on others.
- Other staff on the same network hit the same loop on the same URL.

## Causes & fixes

1. **You are using `http://` instead of `https://` (most common).** The staff session cookie (`__vibe_app_session`) is `Secure` whenever `APP_BASE_URL` starts with `https://`, and `SameSite=Strict`. A `Secure` cookie is silently dropped over plain `http://`, so the next request arrives with no session. Fix: open the app over its HTTPS URL — on a LAN appliance that's `https://<host>:5195` served by Caddy with `tls internal`. Accept or import the Caddy local-CA certificate once.
2. **`APP_BASE_URL` doesn't match how you reach the app.** The `Secure` flag is decided from `APP_BASE_URL`, not the incoming request. Fix (operator): set `APP_BASE_URL` to the exact scheme + host + port users type, then restart the API.
3. **Bare IP over HTTPS and the handshake fails.** TLS clients hitting a bare IP send no SNI. The local Caddyfile sets `default_sni {$VIBE_HOST:localhost}`. Fix (operator): set `VIBE_HOST` to the appliance IP/hostname so the cert and default_sni match.
4. **Wrong realm / cookie.** Staff and portal are fully separate (`__vibe_app_session` vs `__vibe_portal_session`). Fix: use the staff URL for staff and the portal URL for clients; don't reuse one tab across both.
5. **Signed in but everything is forbidden (403).** Your user has no role. Fix: ask an admin to assign one in **Admin → People**.
6. **Cookies blocked or cleared.** Privacy extensions or aggressive cookie clearing can drop the session. Fix: allow cookies for the app host and retry.

## Tips

- Fastest test: if the address bar shows `http://`, switch to `https://` and sign in again.
- Sessions last 7 days; constant re-prompts even over HTTPS suggest clock skew or a cookie-clearing extension.
- Operators: after changing `APP_BASE_URL` or `VIBE_HOST`, restart the API and Caddy.
