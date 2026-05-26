// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// FMv2 §5.2 — re-export of the canonical helper in @vibe/core/storage.
//
// The implementation moved there so apps/worker can import without
// a cross-app dependency on @vibe/api. Existing import paths inside
// apps/api keep working through this shim; new callers should
// import directly from '@vibe/core/storage'.

export {
  INDEX_CHANNEL_PREFIX,
  INDEX_STATE_PREFIX,
  INDEX_STATE_TTL_SECONDS,
  indexChannel,
  indexStateKey,
  publishIndexProgress,
  readIndexState,
  type IndexProgressSnapshot,
  type IndexStatus,
} from '@vibe/core/storage';
