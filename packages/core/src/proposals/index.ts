// SPDX-License-Identifier: Elastic-2.0
//
// Browser-safe barrel for the proposals package. Crypto helpers
// (canonical-json, signature-hmac) import `node:crypto` and are
// re-exported from `@vibe/core/proposals/server` instead — they
// must not be pulled into the browser bundle.

export * from './merge-tokens';
export * from './blocks';
export * from './video-embed';
export * from './renewal-uplift';
export * from './wip-rollup';
export * from './funnel';
export * from './mrr-rollup';
export { STARTER_TERMS_TEMPLATES, type StarterTemplate } from './starter-templates';
