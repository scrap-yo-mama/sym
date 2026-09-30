// Erreurs de l'interpréteur déclaratif (tâche 1.1b). Les messages ne contiennent jamais de valeur issue d'une page ou d'une API.

export type DslErrorCode =
  | 'invalid_spec'
  | 'invalid_jsonpath'
  | 'invalid_css'
  | 'invalid_regex'
  | 'regex_not_bounded'
  | 'unknown_operator'
  | 'operator_failed'
  | 'invalid_json'
  | 'invalid_blob'
  | 'blob_not_found'
  | 'invalid_template'
  | 'host_not_allowed'
  | 'unsupported'
  | 'response_too_large'
  | 'depth_exceeded'
  | 'too_many_items'
  | 'too_many_nodes'
  | 'value_too_large'
  | 'timeout';

export class DslError extends Error {
  readonly code: DslErrorCode;
  constructor(code: DslErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DslError';
    this.code = code;
  }
}
