// SPDX-License-Identifier: PolyForm-Internal-Use-1.0.0
//
// PP4b / P05 — Per-block-type validators. Plugged into validateTree()
// on every tree change so the editor can flag malformed blocks before
// the firm sends the proposal.
//
// Convention: throw BlockValidationError with a stable `code`. The
// editor catches and renders the message inline on the failing block.

import { BlockValidationError, parseVideoUrl, type BlockTypeValidator } from '@vibe/core/proposals';

const MARKDOWN: BlockTypeValidator = {
  type: 'markdown',
  validate(props) {
    if (typeof props['md'] !== 'string') {
      throw new BlockValidationError(
        '',
        'markdown',
        'invalid_props',
        'markdown body must be a string',
      );
    }
  },
};

const HEADING: BlockTypeValidator = {
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

const DIVIDER: BlockTypeValidator = {
  type: 'divider',
  validate() {
    // no props
  },
};

const COVER: BlockTypeValidator = {
  type: 'cover',
  validate(props) {
    if (typeof props['title'] !== 'string' || props['title'].trim() === '') {
      throw new BlockValidationError('', 'cover', 'empty_title', 'cover title cannot be empty');
    }
    for (const k of ['heroImageUrl', 'firmLogoUrl'] as const) {
      const v = props[k];
      if (v != null && v !== '' && typeof v !== 'string') {
        throw new BlockValidationError('', 'cover', 'invalid_url', `${k} must be a URL string`);
      }
    }
  },
};

const VIDEO: BlockTypeValidator = {
  type: 'video',
  validate(props) {
    const url = props['url'];
    if (typeof url !== 'string' || url.trim() === '') {
      // Allow an empty draft state — the editor surfaces an empty-video
      // hint instead. v1.5 may upgrade this to a required-field error
      // at send-time.
      return;
    }
    if (!parseVideoUrl(url)) {
      throw new BlockValidationError(
        '',
        'video',
        'unrecognized_video_url',
        'URL must be YouTube, Vimeo, or Loom',
      );
    }
  },
};

const SERVICES_LIST: BlockTypeValidator = {
  type: 'services_list',
  validate(props) {
    const ids = props['serviceIds'];
    if (!Array.isArray(ids)) {
      throw new BlockValidationError(
        '',
        'services_list',
        'invalid_props',
        'serviceIds must be an array',
      );
    }
    if (ids.length === 0) {
      throw new BlockValidationError(
        '',
        'services_list',
        'empty_list',
        'pick at least one service',
      );
    }
  },
};

const PACKAGE_SELECTOR: BlockTypeValidator = {
  type: 'package_selector',
  validate(props) {
    const name = props['packageName'];
    if (typeof name !== 'string' || name.trim() === '') {
      throw new BlockValidationError(
        '',
        'package_selector',
        'no_package',
        'pick a package to offer',
      );
    }
  },
};

const TERMS: BlockTypeValidator = {
  type: 'terms',
  validate(props) {
    const id = props['termsTemplateId'];
    if (typeof id !== 'string' || id.trim() === '') {
      throw new BlockValidationError('', 'terms', 'no_template', 'pick a terms template');
    }
  },
};

const SIGNATURE: BlockTypeValidator = {
  type: 'signature',
  validate(props) {
    if (typeof props['label'] !== 'string' || props['label'].trim() === '') {
      throw new BlockValidationError(
        '',
        'signature',
        'empty_label',
        'signature field label cannot be empty',
      );
    }
    if (typeof props['acceptanceCopy'] !== 'string' || props['acceptanceCopy'].trim() === '') {
      throw new BlockValidationError(
        '',
        'signature',
        'empty_copy',
        'acceptance copy cannot be empty',
      );
    }
  },
};

export const VALIDATORS = new Map<string, BlockTypeValidator>([
  [MARKDOWN.type, MARKDOWN],
  [HEADING.type, HEADING],
  [DIVIDER.type, DIVIDER],
  [COVER.type, COVER],
  [VIDEO.type, VIDEO],
  [SERVICES_LIST.type, SERVICES_LIST],
  [PACKAGE_SELECTOR.type, PACKAGE_SELECTOR],
  [TERMS.type, TERMS],
  [SIGNATURE.type, SIGNATURE],
]);
