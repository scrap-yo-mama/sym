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
// INV10 (0.7, 2.5) : assert_ssrf_guard et assert_webhook_ssrf_blocked (enregistrement, envoi brut, livraison signée de 2.5) sont dans
// tests/security/ssrf-guard.security.test.ts (projet Vitest security, pnpm test:security) ; côté base : webhooks.integration.test.ts.
// 2.5 (planification, webhooks, alertes) : assert_schedule_skips_bloquee, assert_schedule_single_source (packages/db/src/schedules.integration.test.ts,
// apps/worker/src/scheduling.integration.test.ts), assert_webhook_signature (packages/core/src/webhook/webhook.unit.test.ts, webhooks.integration.test.ts),
// assert_webhook_retry, assert_webhook_blocked_not_retryable (webhooks.integration.test.ts), assert_alert_actionable (alerts.integration.test.ts).
// INV3 (1.2) : assert_status_transitions est dans packages/core/src/status/transitions.unit.test.ts (21 tests transition_NN_*),
// machine.prop.test.ts (modèle fast-check) et packages/db/src/status.integration.test.ts (status_events, même transaction).
// INV4 et D-12 (1.3) : assert_run_traced et assert_worker_key_mismatch sont dans apps/worker/src/worker.integration.test.ts (worker réel,
// kill -9 et SIGTERM compris) ; file, balayeur et bail : packages/db/src/runs.integration.test.ts.
// INV5 (2.6) : assert_identity_pinned (volet cookies : un run n'ouvre que la session du propriétaire de l'API) est dans
// apps/server/src/extension.integration.test.ts, packages/core/src/auth/extension.unit.test.ts (AAD) et apps/extension/e2e
// (E2) ; le volet tunnel est repris par 2.7 avec assert_tunnel_single_user. assert_consent_before_capture,
// assert_optional_hosts, assert_no_cookie_in_tunnel_mode : apps/extension/src/core/*.unit.test.ts et e2e/extension.e2e.ts.
// INV6, X4 (1.4) : assert_no_ip_change_after_refusal est dans tests/network/network-modes.unit.test.ts (proxy de test local).
// INV9 et exploitation (4.6) : assert_diagnostics_redacted (packages/db/src/ops/ops.integration.test.ts, apps/cli/src/cli.ops.integration.test.ts),
// assert_backup_restore_roundtrip, assert_upgrade_n_minus_1, assert_rollback_restores_state (tests/operations.integration.test.ts).
// INV9 et INV8 (1.10) : assert_no_telemetry (serveur + worker + run, 0 destination non locale), assert_otel_off_by_default,
// assert_otel_optin_local_only, assert_no_traceparent_outbound et l'extension de assert_no_secret_in_logs à toutes les sorties
// sont dans tests/observability.integration.test.ts (dont le contrôle des modules résolus par un vrai server + worker : ni
// l'API ni le SDK OTel, seule @opentelemetry/semantic-conventions, constantes importées par Better Auth, est tolérée) ;
// @runtime/core seul : packages/core/src/observability/observability.unit.test.ts ; assert_metrics_closed :
// apps/server/src/observability.integration.test.ts.
// La capture de trafic complète (cibles, LLM, proxys, SMTP, webhooks réels) de assert_no_telemetry reste à 4.3.
// INV7 (1.5) : assert_sandbox est dans apps/worker/src/sandbox/sandbox.security.test.ts (projet Vitest security,
// isolated-vm et adaptateur QuickJS) ; borne isolated-vm et fuzz des ponts : apps/worker/src/sandbox/sandbox.unit.test.ts.
// INV6 (3.5) : assert_ui_strings_no_forbidden_words est dans tests/ui-strings.unit.test.ts (fichiers de langue en et fr, messages
// de apps/server/src et de packages/*/src, dont MCP ; un module MCP né hors de ces dossiers fait échouer le test) ; assert_blocked_panel_no_tunnel_link dans apps/web/src/components/BlockedPanel.unit.test.ts.
describe("invariants (à implémenter)", () => {
  test.todo("assert_cheapest_first_logged"); // INV2, tâche(s) 2.1
  test.todo("assert_tunnel_single_user"); // INV5, tâche(s) 2.6, 2.7
  test.todo("assert_no_circumvention"); // INV6, tâche(s) 1.7, 4.3
  test.todo("assert_robots_respected"); // INV11, tâche(s) 1.11
  // RGPD (1.8) : assert_retention_purge, assert_erasure_complete et assert_no_personal_data_in_logs sont dans
  // packages/db/src/retention/retention.integration.test.ts ; câblage worker (RunContext.personal, RunContext.excludeSubjects,
  // rekey) dans apps/worker/src/worker.integration.test.ts. Câblage par l'exécuteur réel (D-28, tâche 1.6) : items extraits
  // inscrits à RunContext.personal et sujets effacés exclus avant écriture du dataset, journaux par ctx.log (appendRunLog
  // avec le registre du run) : apps/worker/src/exec/strategy-executor.integration.test.ts (« RGPD (D-28) ») ; `ctx.log` d'un script E3
// (run_logs masqué, jamais le journal du worker) : apps/worker/src/sandbox/sandbox.unit.test.ts, tests/browser/executors.security.test.ts
// et apps/worker/src/exec/strategy-executor.security.test.ts (Chromium réel, base réelle). Reste la
  // déduplication, qui naît avec `dedup_key` / `diff` des planifications (08 §5, tâche 2.5) :
  test.todo("assert_erasure_complete — dedup_keys.key_hash = dedupKeyHash(clé des sujets, dedup_key) à l'écriture des clés"); // RGPD, tâche(s) 2.5
  test.todo("assert_pacing_key_is_domain"); // politesse, tâche(s) 1.9
  test.todo("assert_export_no_secret"); // INV5, INV8, tâche(s) 3.12
  test.todo("assert_access_report_first"); // étape 0, tâche(s) 1.11, 2.1
  test.todo("assert_budget_and_stop_controls — Chromium (Playwright) : attempt.finished émis → [data-testid=attempt] visible en moins de 2 s"); // 06 § 4.3, tâche(s) 3.6 (3.5 : rendu SSR, sans navigateur)
  test.todo("assert_run_detail_error_open"); // 06 § 4.3 : écran Détail d'un run, confié à aucune tâche (ADR 0003 : 3.4 ou tâche nouvelle), E2E 3.6
  test.todo("assert_a11y_axe_clean"); // 06 § 1, tâche(s) 3.9, 3.6 (passage ponctuel de 3.3 consigné dans l'ADR 0002)
});
