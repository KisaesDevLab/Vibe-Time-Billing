// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// PP4b — Per-block-type validators. Plugged into validateTree() on
// every tree change so the editor can flag malformed blocks before
// the firm sends the proposal.

import { BlockValidationError, type BlockTypeValidator } from '@vibe/core/proposals';

const TEXT_VALIDATOR: BlockTypeValidator = {
  type: 'text',
  validate(props) {
    if (typeof props['md'] !== 'string') {
      throw new BlockValidationError(
        '',
        'text',
        'invalid_props',
        'text block requires a markdown body',
      );
    }
  },
};

const HEADING_VALIDATOR: BlockTypeValidator = {
  type: 'heading',
  validate(props) {
    if (typeof props['text'] !== 'string' || props['text'].trim() === '') {
      throw new BlockValidationError(
        '',
        'heading',
        'empty_heading',
        'heading text cannot be empty',
      );
    }
    const lvl = Number(props['level']);
    if (!Number.isInteger(lvl) || lvl < 1 || lvl > 3) {
      throw new BlockValidationError(
        '',
        'heading',
        'invalid_level',
        'heading level must be 1, 2, or 3',
      );
    }
  },
};

const DIVIDER_VALIDATOR: BlockTypeValidator = {
  type: 'divider',
  validate() {
    // Divider has no props to validate.
  },
};

export const VALIDATORS = new Map([
  [TEXT_VALIDATOR.type, TEXT_VALIDATOR],
  [HEADING_VALIDATOR.type, HEADING_VALIDATOR],
  [DIVIDER_VALIDATOR.type, DIVIDER_VALIDATOR],
]);
