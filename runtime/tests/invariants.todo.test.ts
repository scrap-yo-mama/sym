// SPDX-License-Identifier: AGPL-3.0-only
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
// INV1 (1.1a) : assert_output_schema_enforced est dans packages/core/src/schema/validator.unit.test.ts (validateOutput, `$ref` distant
// refusé à 0 requête) ; le volet « sortie LLM » et « réparation » est repris par 2.3.
// INV10 (0.7) : assert_ssrf_guard et assert_webhook_ssrf_blocked (squelette repris par 2.5) sont dans
// tests/security/ssrf-guard.security.test.ts (projet Vitest security, pnpm test:security).
// INV3 (1.2) : assert_status_transitions est dans packages/core/src/status/transitions.unit.test.ts (21 tests transition_NN_*),
// machine.prop.test.ts (modèle fast-check) et packages/db/src/status.integration.test.ts (status_events, même transaction).
// INV4 et D-12 (1.3) : assert_run_traced et assert_worker_key_mismatch sont dans apps/worker/src/worker.integration.test.ts (worker réel,
// kill -9 et SIGTERM compris) ; file, balayeur et bail : packages/db/src/runs.integration.test.ts.
// INV5 (2.6) : assert_identity_pinned (volet cookies : un run n'ouvre que la session du propriétaire de l'API) est dans
// apps/server/src/extension.integration.test.ts, packages/core/src/auth/extension.unit.test.ts (AAD) et apps/extension/e2e
// (E2) ; le volet tunnel est repris par 2.7 avec assert_tunnel_single_user. assert_consent_before_capture,
// assert_optional_hosts, assert_no_cookie_in_tunnel_mode : apps/extension/src/core/*.unit.test.ts et e2e/extension.e2e.ts.
// INV6, X4 (1.4) : assert_no_ip_change_after_refusal est dans tests/network/network-modes.unit.test.ts (proxy de test local).
describe("invariants (à implémenter)", () => {
  test.todo("assert_cheapest_first_logged"); // INV2, tâche(s) 2.1
  test.todo("assert_tunnel_single_user"); // INV5, tâche(s) 2.6, 2.7
  test.todo("assert_no_circumvention"); // INV6, tâche(s) 1.7, 4.3
  test.todo("assert_sandbox"); // INV7, tâche(s) 1.5
  test.todo("assert_no_telemetry"); // INV9, tâche(s) 1.10, 4.3 (part auth de 0.3b : apps/server/src/telemetry.integration.test.ts)
  test.todo("assert_otel_off_by_default"); // INV9, tâche(s) 1.10, 4.3
  test.todo("assert_robots_respected"); // INV11, tâche(s) 1.11
  test.todo("assert_retention_purge"); // RGPD, tâche(s) 1.8
  test.todo("assert_erasure_complete"); // RGPD, tâche(s) 1.8
  test.todo("assert_no_personal_data_in_logs"); // RGPD, tâche(s) 1.8, 1.10
  test.todo("assert_pacing_key_is_domain"); // politesse, tâche(s) 1.9
  test.todo("assert_export_no_secret"); // INV5, INV8, tâche(s) 3.12
  test.todo("assert_diagnostics_redacted"); // INV9, tâche(s) 1.10
  test.todo("assert_ui_strings_no_forbidden_words"); // INV6, tâche(s) 3.5
  test.todo("assert_access_report_first"); // étape 0, tâche(s) 1.11, 2.1
});
