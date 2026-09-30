// Table 15 §12 : un test.todo par test nommé. Un test todo est remplacé par le vrai test à la tâche indiquée.
// Vérifié par scripts/check-invariants.ts (job quality) : chaque assert_* de tests/invariants.json doit exister ici ou dans un autre fichier de test.
import { describe, test } from "vitest";

// INV8 (0.3a) : assert_encrypted_at_rest, assert_aad_binding, assert_rekey_complete, assert_key_loss_detected, assert_no_secret_in_logs
// sont dans packages/core/src/crypto/*.unit.test.ts et packages/db/src/secrets.integration.test.ts (extension aux spans,
// métriques et artefacts : tâche 1.10).
// INV5, INV12 et auth noyau (0.3b) : assert_no_impersonation, assert_cross_user_denied (routes : apps/server/src/authz.integration.test.ts ;
// SQL brut : packages/db/src/rls.integration.test.ts), assert_authz_matrix (squelette, complété en 4.3), assert_bootstrap_once,
// assert_auth_baseline (apps/server/src/auth.integration.test.ts), assert_audit_append_only (rls.integration.test.ts),
// assert_api_key_scopes (packages/core/src/auth/auth.unit.test.ts). Extension de assert_cross_user_denied à MCP et aux
// ressources de 3.1 / 2.6 : registre apps/server/src/routes/registry.ts.
describe("invariants (à implémenter)", () => {
  test.todo("assert_output_schema_enforced"); // INV1, tâche(s) 1.1a, 2.3
  test.todo("assert_cheapest_first_logged"); // INV2, tâche(s) 2.1
  test.todo("assert_status_transitions"); // INV3, tâche(s) 1.2
  test.todo("assert_run_traced"); // INV4, tâche(s) 1.3
  test.todo("assert_identity_pinned"); // INV5, tâche(s) 2.6, 2.7
  test.todo("assert_tunnel_single_user"); // INV5, tâche(s) 2.6, 2.7
  test.todo("assert_no_circumvention"); // INV6, tâche(s) 1.7, 4.3
  test.todo("assert_sandbox"); // INV7, tâche(s) 1.5
  test.todo("assert_no_telemetry"); // INV9, tâche(s) 1.10, 4.3 (part auth de 0.3b : apps/server/src/telemetry.integration.test.ts)
  test.todo("assert_otel_off_by_default"); // INV9, tâche(s) 1.10, 4.3
  test.todo("assert_ssrf_guard"); // INV10, tâche(s) 0.7
  test.todo("assert_webhook_ssrf_blocked"); // INV10, tâche(s) 0.7, 2.5
  test.todo("assert_robots_respected"); // INV11, tâche(s) 1.11
  test.todo("assert_retention_purge"); // RGPD, tâche(s) 1.8
  test.todo("assert_erasure_complete"); // RGPD, tâche(s) 1.8
  test.todo("assert_no_personal_data_in_logs"); // RGPD, tâche(s) 1.8, 1.10
  test.todo("assert_llm_redaction"); // RGPD, tâche(s) 0.4
  test.todo("assert_pacing_key_is_domain"); // politesse, tâche(s) 1.9
  test.todo("assert_export_no_secret"); // INV5, INV8, tâche(s) 3.12
  test.todo("assert_diagnostics_redacted"); // INV9, tâche(s) 1.10
  test.todo("assert_ui_strings_no_forbidden_words"); // INV6, tâche(s) 3.5
  test.todo("assert_access_report_first"); // étape 0, tâche(s) 1.11, 2.1
});
