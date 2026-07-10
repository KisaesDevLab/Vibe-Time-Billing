// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Single source of truth for the staff app's product display name. Change
// it here and every UI surface (auth screens, shell header, onboarding,
// page title) follows. This is a *display* name only — it has no bearing
// on package names, the `vibetb` DB schema, docker service names, or any
// other functional identifier.
export const BRAND = 'Vibe Practice Management';

/** Short form for tight spots (PWA short_name, compact chips). */
export const BRAND_SHORT = 'Vibe PM';
