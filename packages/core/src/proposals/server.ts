// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Server-only barrel for the proposals package. Pulls in Node-only
// crypto modules (node:crypto) so it must NOT be imported from
// browser code — Vite would fail the production build with
// "createHash is not exported by __vite-browser-external".
//
// Use `@vibe/core/proposals` for browser-safe exports (merge tokens,
// block tree validators, renewal/MRR/WIP rollup math, etc.) and
// `@vibe/core/proposals/server` for the crypto helpers below.

export * from './canonical-json';
export * from './signature-hmac';
