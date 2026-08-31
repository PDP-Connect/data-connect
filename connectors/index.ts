// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * Connectors Index
 *
 * Re-exports types from connector modules.
 * The actual connector scripts are plain JS files loaded by the Playwright runner.
 */

// Instagram connector - types and schemas
export type {
  InstagramScrapeResult,
  InstagramScrapeParams,
  ProfileInfo,
  Post,
  LikedPost,
} from './instagram/index.js';
