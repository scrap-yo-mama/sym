// SPDX-License-Identifier: AGPL-3.0-only
// Couche LLM (tâche 0.4) : transport Chat Completions maison, providers[] par rôle, sonde de capacités, échelle S1-S4 + Ajv final.
export const PACKAGE_NAME = '@runtime/llm';

export * from './types.js';
export * from './errors.js';
export { classifyFailure, extractErrorFields, parseRetryAfter, type FailureInfo } from './classify.js';
export * from './usage.js';
export * from './redact.js';
export * from './profile.js';
export * from './schema.js';
export * from './transport.js';
export * from './client.js';
export * from './settings.js';
export * from './known-prices.js';
