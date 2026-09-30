// Table 15 §12 : un test.todo par test nommé. Un test todo est remplacé par le vrai test à la tâche indiquée.
// Vérifié par scripts/check-invariants.ts (job quality) : chaque assert_* de tests/invariants.json doit exister ici ou dans un autre fichier de test.
import { describe, test } from "vitest";

describe("invariants (à implémenter)", () => {
  test.todo("assert_output_schema_enforced"); // INV1, tâche(s) 1.1a, 2.3
  test.todo("assert_cheapest_first_logged"); // INV2, tâche(s) 2.1
  test.todo("assert_status_transitions"); // INV3, tâche(s) 1.2
  test.todo("assert_run_traced"); // INV4, tâche(s) 1.3
  test.todo("assert_identity_pinned"); // INV5, tâche(s) 2.6, 2.7
  test.todo("assert_tunnel_single_user"); // INV5, tâche(s) 2.6, 2.7
  test.todo("assert_no_impersonation"); // INV5, tâche(s) 0.3b
  test.todo("assert_no_circumvention"); // INV6, tâche(s) 1.7, 4.3
  test.todo("assert_sandbox"); // INV7, tâche(s) 1.5
  test.todo("assert_encrypted_at_rest"); // INV8, tâche(s) 0.3a, 1.10
  test.todo("assert_no_secret_in_logs"); // INV8, tâche(s) 0.3a, 1.10
  test.todo("assert_aad_binding"); // INV8, tâche(s) 0.3a
  test.todo("assert_rekey_complete"); // INV8, tâche(s) 0.3a
  test.todo("assert_no_telemetry"); // INV9, tâche(s) 1.10, 4.3
  test.todo("assert_otel_off_by_default"); // INV9, tâche(s) 1.10, 4.3
  test.todo("assert_ssrf_guard"); // INV10, tâche(s) 0.7
  test.todo("assert_webhook_ssrf_blocked"); // INV10, tâche(s) 0.7, 2.5
  test.todo("assert_robots_respected"); // INV11, tâche(s) 1.11
  test.todo("assert_cross_user_denied"); // INV12, tâche(s) 0.3b, 4.3
  test.todo("assert_retention_purge"); // RGPD, tâche(s) 1.8
  test.todo("assert_erasure_complete"); // RGPD, tâche(s) 1.8
  test.todo("assert_no_personal_data_in_logs"); // RGPD, tâche(s) 1.8, 1.10
  test.todo("assert_llm_redaction"); // RGPD, tâche(s) 0.4
  test.todo("assert_pacing_key_is_domain"); // politesse, tâche(s) 1.9
  test.todo("assert_export_no_secret"); // INV5, INV8, tâche(s) 3.12
  test.todo("assert_diagnostics_redacted"); // INV9, tâche(s) 1.10
  test.todo("assert_ui_strings_no_forbidden_words"); // INV6, tâche(s) 3.5
  test.todo("assert_access_report_first"); // étape 0, tâche(s) 1.11, 2.1
  test.todo("assert_x6_guard"); // X6, tâche(s) 0.1, 0.8
});
