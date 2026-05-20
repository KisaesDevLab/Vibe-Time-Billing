// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Re-export shim. The Stripe implementation lives in @vibe/core/payments
// so both the API process and the BullMQ worker (apps/worker) can use it
// without a cross-app import.
export { createStripeProvider, type StripeProviderOptions } from '@vibe/core/payments';
