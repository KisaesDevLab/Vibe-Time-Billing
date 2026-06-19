---
title: 'Enabling AI & the cost cap'
slug: enabling-ai
category: ai
audience: staff
tags: ['ai', 'enable', 'budget', 'egress', 'shield']
---

# Enabling & configuring AI

AI providers and cloud egress are configured on the **AI settings** admin page (`/admin/ai-settings`, titled **AI settings**); the spending cap and provider preference live on **Admin → Firm settings**. Saving here requires `firm:settings:write`.

## Configure a provider

1. Open **Admin → AI settings**. Each provider type has its own credential card:
   - **Anthropic (Claude)** (cloud) — enter the **API key** and **Model**.
   - **OpenAI-compatible** (cloud) — enter the **Base URL**, **API key**, and **Model** (use this for Groq, Together, vLLM, LM Studio, llama.cpp servers, etc.).
   - **Ollama (local)** — enter the **Base URL** and **Model**; no key needed.
2. Optionally set per-token pricing on the cloud cards: **Input ¢ / 1M tok** and **Output ¢ / 1M tok** (so usage and the budget cap cost correctly). Ollama is costed at $0.
3. Click **Save** to store the card, **Test connection** to verify it reaches the provider, or **Remove** to clear it. Credentials are stored encrypted in the database (not env vars).

## Configure cloud egress

4. On the **Cloud egress** card, leave it **Disabled (local-only)** to keep every call on the local provider, or enable it and pick a **Mode**:
   - **Direct (no shield)** — cloud calls go straight to the provider.
   - **Shield (proxy)** — cloud calls route through the **Vibe Shield endpoint** you enter on the card; calls only succeed while Shield is reachable, otherwise they fall back to local.
5. Click **Save egress**.

## Set the budget and preference

6. Open **Admin → Firm settings** → the **Approvals + auth + AI** card and set **AI monthly budget ($)** (warn at 80%, hard cap at 100%) and **AI provider preference** (**Default (local-first)**, **Force local (Ollama)**, or **Force cloud (Anthropic)**).

## What you'll see

- The **Cloud egress** card shows a status pill — **Enabled · <mode>** or **Disabled (local-only)**.
- The **AI status** card on **Admin → AI usage** shows three pills: **Status** (`enabled`/`disabled`), **Opted in** (`yes`/`no`), and **Provider** (the provider id or `none`).
- Staff-facing AI panels appear only when the firm is opted in, enabled, and a provider is wired.

## How staff see AI availability

- The web app calls `/api/staff/ai/status` once per session and caches the result.
- A panel is shown only when status reports `enabled`, `optedIn`, and `providerWired` are all true.
- When AI is unavailable, the **Ask AI** tab shows "Ask AI is not enabled" and points staff to enable a provider and to use the **Knowledge Base** tab.

## Tips

- Keep egress **Disabled (local-only)** for maximum data sovereignty — only the Ollama card is needed.
- Local providers cost $0, so a local-only firm can leave the budget conservative without blocking work.
- A cloud override on a feature is still blocked unless the **Cloud egress** card allows it.
