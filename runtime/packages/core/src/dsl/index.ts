// Interpréteur de stratégie déclarative (tâche 1.1b, 04b § 2) : sans I/O réseau.
export { DslError, type DslErrorCode } from './errors.js';
export { DEFAULT_DSL_LIMITS, HARD_DSL_LIMITS, resolveLimits, type DslLimits } from './limits.js';
export { compileJsonPath, queryValues } from './jsonpath.js';
export { assertBoundedRegex, compileBoundedRegex } from './regex.js';
export { compileSelector, parseHtml } from './css.js';
export { OPERATOR_NAMES, applyOperators, compileOperators, type OperatorName } from './operators.js';
export { BLOB_KINDS, decodeEmbedded, type BlobKind, type BlobLocator } from './blobs.js';
export {
  DECLARATIVE_SPEC_SCHEMA,
  SPEC_SCHEMA_VERSION,
  validateDeclarativeSpec,
  type DeclarativeSpec,
  type FieldSpec,
  type FieldType,
  type PaginationType,
  type RequestSpec,
  type SourceFrom,
  type SourceSpec,
  type SpecIssue,
  type StepSpec,
  type StopCondition,
  type SpecValidation,
} from './spec.js';
export { extractRecords, type ExtractOptions, type ExtractResult, type Problem, type ProblemCode, type ResponseInput, type SourceAttempt } from './extract.js';
export { renderRequest, type RenderedRequest, type TemplateContext } from './template.js';
export { advancePagination, initialParam, parseLinkNext, resolveNextUrl, startPagination, type PageOutcome, type PageState, type PaginationDecision, type StopReason } from './pagination.js';
export { PATCHABLE_ROOTS, patchKey, validateRepairPatch, type PatchCheck, type PatchRejection, type PatchRejectionCode } from './patch.js';
export { shapeFingerprint } from './fingerprint.js';
