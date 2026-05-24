# AI Egress Policy

## Default posture: local-only

The appliance ships with **`firm_config.ai_egress_enabled = false`** by default and **`firm_config.vibe_shield_endpoint = NULL`**. With both unset, AI features that need a model run against the local Ollama / OpenAI-compatible provider configured at install time. The Anthropic provider (cloud egress) is wired in `apps/api/src/ai/anthropic.ts` but unreachable from any route when the egress gate is off.

This matches the locked decision in `QUESTIONS.md` Q15 (local-first AI) and the appliance's self-hosting promise.

## Why a Shield gate exists in plan but not in code

Vibe Shield is a sibling product that intercepts outbound API calls, applies firm-controlled redaction rules to the payload (e.g., strip SSNs and account numbers), and then proxies the request to the upstream provider (Anthropic, OpenAI, etc.). It's the trust boundary that makes opting into cloud AI defensible.

Shield is **not built yet**. Until it is, the appliance refuses to use the cloud provider even if a token is set in env. The check lives at request time:

```ts
// (Future) - pseudocode for the gate
if (provider.kind === 'cloud') {
  if (!firm_config.ai_egress_enabled) throw new Error('cloud_egress_disabled');
  if (!firm_config.vibe_shield_endpoint) throw new Error('cloud_egress_requires_shield');
  // route the call through firm_config.vibe_shield_endpoint instead of provider's URL
}
```

The two `firm_config` columns are in place (migration `0058`) to receive this wiring without another schema change.

## How an operator turns on cloud AI (future)

1. Install Vibe Shield on the same host or on a trusted internal network.
2. Configure Shield's redaction rules for the firm (PII categories, regex patterns).
3. Update `firm_config`:
   - `vibe_shield_endpoint = 'https://shield.firm.internal'`
   - `ai_egress_enabled = true`
4. Set the upstream provider's API key in env (`AI_CLOUD_API_KEY`).
5. Restart the API.

Until Shield is built, none of this is reachable; the gate refuses to route.

## What's allowed today

| Feature                                                    | Provider                                                                    |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| Local LLM-backed text generation (summarization, drafting) | Local Ollama / OpenAI-compatible (no egress)                                |
| MCP HTTP shim                                              | Read-only DB access; no AI involved unless the agent calls a local provider |
| Time-entry suggestions, scope-creep alerts                 | Heuristics in `@vibe/core`; no model required                               |

## What's blocked today

- Anthropic Claude direct calls — `cloudAiProvider` is wired in `server.ts` only if `AI_CLOUD_API_KEY` is set; even then routes that gate on egress refuse.
- Any future per-firm "ask Claude" feature — must wait for Shield.

## Where to look

- `apps/api/src/ai/` — Anthropic / Ollama / OpenAI-compatible providers
- `packages/db/migrations/0058_firm_config_and_key_envelope.sql` — `firm_config.ai_egress_enabled`, `firm_config.vibe_shield_endpoint`
- `QUESTIONS.md` Q14, Q15 — cost caps, hardware-adaptive local model

## Threat model summary

| Threat                                       | Mitigation                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Data exfiltration via outbound LLM API call  | Egress disabled by default; flag requires Shield endpoint to flip                                       |
| PII leaking into prompts                     | Shield redacts at the boundary; until then, only local models see prompts                               |
| Compromised vendor API key                   | Worst-case = vendor sees redacted prompts; the appliance owns the key, can rotate or revoke immediately |
| Model returning sensitive data from training | Out of scope — same risk as any LLM use; documented in firm-side policy                                 |
