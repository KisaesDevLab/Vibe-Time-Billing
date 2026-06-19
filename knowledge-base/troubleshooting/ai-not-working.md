---
title: 'The AI assistant is disabled or not answering'
slug: ai-not-working
category: troubleshooting
audience: staff
tags: ['troubleshooting', 'ai', 'chat']
---

# Ask AI / AI features aren't available

AI panels (description suggestions, narratives, the support chat, plain-English queries) are hidden, greyed out, or returning errors. The app gates every AI feature behind several checks; the status endpoint tells you which one is failing.

## Symptoms

- AI buttons/panels don't appear at all in the staff app.
- An AI action returns `no_ai_provider` (503), `ai_budget_exhausted` (402), or `ai_provider_failed` (502).
- AI worked, then suddenly stopped mid-month.
- Cloud AI is configured but calls still behave as if no provider exists.

## Causes & fixes

1. **Check `/api/staff/ai/status` first.** It returns `enabled`, `optedIn`, `providerWired`, and `providerId`, where `enabled = optedIn && providerWired`. The UI hides AI panels whenever `enabled` is false.
2. **No provider wired (`providerWired: false`, `no_ai_provider`).** Local is preferred: set a local provider (Ollama URL + model) or a cloud provider (`AI_CLOUD_API_KEY` + model). Fix: configure at least one and restart the API.
3. **Firm opted out (`optedIn: false`).** Controlled by `VIBE_AI_DISABLED`; when `true`, all AI is disabled. Fix (operator): unset it and restart.
4. **Budget exhausted (`ai_budget_exhausted`, 402).** A per-firm monthly budget is checked against month-to-date spend in `ai_request_log`. At the warn threshold (default 80%) calls still succeed with a warning; at 100% they're hard-capped. Fix: raise the budget in **Admin → Firm settings**, or wait for the reset (the response includes `resetsOn`). Review usage in **Admin → AI usage**.
5. **Cloud blocked by egress / Vibe Shield.** Cloud calls only happen when the firm has egress enabled AND a Shield endpoint set AND Shield is currently reachable (a healthcheck refreshes reachability in Redis). With egress off (the secure default) every call is forced local, and a cloud override is silently downgraded. Fix: enable egress + set a reachable Shield endpoint, or wire a local provider so AI works offline.
6. **Provider configured but failing (`ai_provider_failed`, 502).** The provider was reached but errored (model not pulled in Ollama, bad cloud key, timeout). Fix: confirm the local model is downloaded / the cloud key is valid; failures are recorded in the AI request log.

## Tips

- Local-first is the design: a wired local provider keeps AI working even when cloud egress is denied.
- The support chat is grounded only in published Knowledge Base articles and will say so plainly if nothing matches — that's expected.
- Admins can see per-feature request counts, cost, latency, and failures under **Admin → AI usage**.
