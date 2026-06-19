---
title: 'AI features & the support assistant'
slug: ai-overview
category: ai
audience: staff
tags: ['ai', 'assistant', 'ollama', 'anthropic', 'chat']
---

# AI features overview

The app ships with an optional, **local-first** AI layer that powers in-app drafting, narratives, and a knowledge-base-grounded support chat. Nothing leaves your appliance unless an administrator explicitly enables cloud egress.

## What AI powers

- **Ask AI support chat** — the **Ask AI** tab under **Help & Support**. It retrieves your firm's published Knowledge Base articles and answers using only those articles, with clickable source chips below each reply.
- **Time entry description suggestions** — one-sentence draft descriptions from engagement, work code, and hours context.
- **Realization, scope-creep, capacity, anomaly, and pre-bill narratives** — plain-English partner summaries that wrap the rule-based reports.
- **Pricing renewal suggestions** — a fee/effort/notes block on the **AI usage** admin page.
- **Reason-code and adjustment suggestions**, **plain-English query**, and **natural-language to filter** helpers.

## Multi-provider abstraction

- All features call one `AiProvider` interface, so the same feature runs on any wired provider.
- Three provider types are configured as credential cards on **Admin → AI settings** (`/admin/ai-settings`): **Anthropic (Claude)** (cloud), **OpenAI-compatible** (cloud — Groq, Together, vLLM, LM Studio, llama.cpp server, etc.), and **Ollama (local)**.
- Routing is **local-preferred**: even when cloud is permitted, the local provider is used unless a per-feature override pins it to cloud.

## Budget cap (warn 80% / hard cap 100%)

- Each firm has a monthly AI budget in cents plus a warn threshold.
- At or above the warn threshold (default **80%**), successful AI responses include a `warn` flag with remaining budget.
- At **100%** of the monthly budget, AI calls are blocked with an `ai_budget_exhausted` error and a reset date (the first of next month, UTC). Local Ollama calls are costed at $0, so a local-only firm effectively never exhausts the cap.

## Egress policy / Vibe Shield

- Cloud egress is controlled by the **Cloud egress** card on **Admin → AI settings**. The default is **Disabled (local-only)**: every AI call uses the local provider and cloud is never reached.
- When egress is enabled, the **Mode** control chooses how cloud calls leave the appliance: **Direct (no shield)** sends straight to the provider, or **Shield (proxy)** routes through a **Vibe Shield endpoint** you configure on the card.
- In Shield mode, cloud calls are allowed **only** while Vibe Shield is reachable (status cached by a healthcheck worker); if Shield is unreachable, the call fails safe and falls back to local.
- A cloud override requested while egress is disabled is silently downgraded to local.

## What you'll see

- A consistent **✨ AI · <feature>** panel header on each embedded feature, with a small provider-id tag.
- The **AI settings** admin page (`/admin/ai-settings`) holds the provider credential cards and the egress control; the **AI usage** admin page shows status, request counts, tokens, cost, and a per-feature breakdown.
- Panels render nothing when AI is disabled or no provider is wired, so screens stay clean.

## Tips

- Keep AI fully local for maximum data sovereignty — no setup beyond a local model is required.
- Narrative features only receive aggregated counts/totals, not client PII.
- If Ask AI says it can't answer, browse the **Knowledge Base** tab or ask a firm administrator.
