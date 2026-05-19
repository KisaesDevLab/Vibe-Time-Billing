// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// Seed orchestrator. Phase 2/Phase 5 populate this with firm + offices,
// taxonomy, sample clients, engagement-template starter pack, and three
// portal identities (one with multi-client access).

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('seed: nothing to do yet (Phase 2 wires this up)');
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
