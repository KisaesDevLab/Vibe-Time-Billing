// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// Public callable surface of the DB scripts directory. The CLI shims
// (bootstrap-firm.ts, seed-demo.ts, migrate.ts) all live in the same
// folder but are gated behind their own `process.argv[1]` checks so
// they don't execute on import.

export { runDemoSeed } from './seed-demo';
export type { DemoSeedOptions, DemoSeedResult } from './seed-demo';

export { resetFirmData, PRESERVE_TABLES } from './reset-firm-data';
export type { ResetFirmDataResult } from './reset-firm-data';
