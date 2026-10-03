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
// (E2) ; le volet tunnel (2.7) : assert_tunnel_single_user et assert_gateway_instance_routing dans tests/tunnel/gateway.integration.test.ts. assert_consent_before_capture,
// assert_optional_hosts, assert_no_cookie_in_tunnel_mode : apps/extension/src/core/*.unit.test.ts et e2e/extension.e2e.ts.
// INV6, X4 (1.4) : assert_no_ip_change_after_refusal est dans tests/network/network-modes.unit.test.ts (proxy de test local).
// INV11 et étape 0 (1.11) : assert_robots_respected est dans packages/core/src/access/access.fixtures.unit.test.ts (fixtures O8,
// session réseau réelle : E1, URL saisie à la main, saut de redirection, 4xx/5xx/redirections/500 Kio/Crawl-delay/Content-Signal/402),
// packages/db/src/investigation-events.integration.test.ts (statuts, contrainte robots = respect) et
// apps/worker/src/exec/robots.security.test.ts (worker réel, Chromium : E1, E2, E3, script : page de départ, ctx.fetch, ctx.page.goto ;
// chaque saut de redirection suivi par Chromium, barre oblique finale, second hôte autorisé, WebSocket, robots.txt redirigé vers un
// autre hôte) et apps/worker/src/browser/request-guard.security.test.ts (contrôle CDP : cadre hors processus, worker dédié) ;
// le volet tunnel et extension (17 § 1 : 0 requête aussi en mode tunnel) est repris par 2.7 (test.todo ci-dessous) ;
// assert_access_report_first : packages/db/src/investigation-events.integration.test.ts (migration 0015) et, enquête réelle
// (2.1), apps/worker/src/exec/investigation.integration.test.ts.
// INV2 (2.1) : le test nommé du moins cher d'abord est dans apps/worker/src/exec/investigation.integration.test.ts (sans navigateur),
// apps/worker/src/exec/investigation.security.test.ts (Chromium, capture XHR) et packages/core/src/investigation/investigation.unit.test.ts.
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
// INV6 (1.7) : assert_no_circumvention et assert_circuit_opens_on_refusals sont dans packages/core/src/exec/classify.unit.test.ts,
// classify.fixtures.unit.test.ts, guard.unit.test.ts, apps/worker/src/exec/classification-guard.integration.test.ts,
// tests/browser/executors.security.test.ts (Chromium) et tests/no-circumvention.unit.test.ts (dépendances, imports) ; audit en 4.3.
describe("invariants (à implémenter)", () => {
  // ADR 0001, point faible connu (F-E5, pagination par bouton) : 2.4 ne compile qu'une trace à un enregistrement ; une liste
  // est refusée (`list_not_compilable`, épinglé par assert_e5_list_not_compiled) et reste rejouée par l'agent (E5 « mouvant »).
  // 2.1 (vérification) : une trace E6 n'est jamais retenue sans compilation en E5 (retainedStrategy) ; le code de raison dédié vient avec 2.13.
  test.todo("assert_investigation_not_compilable_reason — enquête dont seule une trace E6 non compilable est conforme, sans instructed_mode : erreur raison not_compilable (transition 2), ré-enquête : statut précédent raison not_compilable (21)"); // 2.13
  test.todo("assert_e5_list_compiled — trace E6 réussie sur F-E5 compilée en E5 (clics « Suivant » répétés, extraction par enregistrement à chaque page) et rejouée sans LLM, sortie identique"); // ADR 0001, suivi de 2.4 (tâche de rattachement à créer dans 10-taches)
  // INV11 (revue de 1.11, journal D-33) : 17 § 1 et le contrat IA de 1.11 exigent 0 requête sur un chemin interdit AUSSI en
  // tunnel et via l'extension. 2.7 (passerelle WSS) a été fusionnée avant 1.11, sans contrôle robots : la tâche de suivi 2.7b
  // contrôle robots.txt avant chaque commande de navigation ou de requête du tunnel (sauts de redirection compris) et
  // remplace ce test.todo par le vrai test ; il ne se retire qu'avec lui.
  test.todo("assert_robots_respected — volet tunnel et extension : 0 requête sur un chemin interdit en mode tunnel, à chaque saut"); // INV11, tâche(s) 2.7b (D-33)
  // 4.8 livrée partiellement (16 § 8, 17 § 11) : la première API est rejouée par le quickstart depuis 3.1 (étape first-api) ; D0
  // reste décrit (mode pending) et gardé par assert_quickstart_pending_steps_declared ; /mcp est livré (3.2), il échoue à la
  // livraison des prompts MCP et du mode démo (3.10).
  test.todo("assert_quickstart_d0_first_api"); // 16 § 8, reprise : 3.1 (première API sur fixture), 3.2 (serveur MCP), 3.10 (D0 en mode démo), vérifié en 4.4
  // Case « j'ai lu » (responsible_use_acks) et refus d'une API x-personal sans elle : livrés par 3.1 (assert_responsible_use_ack,
  // apps/server/src/rest.integration.test.ts). L'affichage de la page au premier lancement de la console reste à faire (console).
  // INV6 (revue de 1.7), câblage livré par 2.3 : le worker porte le run échoué au statut de l'API (10 puis 15 dans le même
  // run, sans réparation) : apps/worker/src/exec/classification-guard.integration.test.ts (status_events écrits par le worker)
  // et apps/worker/src/exec/repair.integration.test.ts (10 puis 12 ou 13).
  // D-49 (2.3) : la quarantaine et l'enveloppe `RunResult.rejected` sont livrées (packages/db/src/rejected.ts) ; leur
  // exposition REST et MCP (3.1 et 3.2 non fusionnées au moment de 2.3) se joue en 4.2.
  test.todo("assert_rejected_items_quarantined — exposition REST et MCP : RunResult.rejected sur get_run et run_api, get_items(rejected: true) à l'appelant du run seul, 404 au propriétaire d'une API instance (05 §4.1)"); // D-49, tâche(s) 4.2 (après 3.1, 3.2)
  // 2.12 (mémoire, profil, juge) : le banc A/B est livré par 2.8, non fusionnée au moment de 2.12 ; les bras « mémoire »
  // et « ablation de la fiche » et la détection des défauts silencieux se jouent en 4.2.
  test.todo("assert_silent_defects_detected — banc 2.8 : défauts silencieux (constante, sentinelles, motif, doublons, valeur d'énumération) détectés par le profil"); // 2.12, joué en 4.2
  test.todo("bras « mémoire » du banc A/B (r1 R18) et ablation du contenu de la fiche (r4 R10) avant de figer run_profiles"); // 2.12, après 2.8, joué en 4.2
  // 2.12 (revue) : validateBaseline et excludeFromBaseline (packages/db/src/quality.ts) n'ont pas encore d'appelant ; tant
  // qu'aucune baseline n'est validée, les motifs comparatifs (pattern_shift, new_enum_value) restent inactifs.
  test.todo("baseline validée par promote_api / test_api (3.14), sortie de baseline sur un retour « ce champ est faux » : motifs pattern_shift et new_enum_value actifs"); // 2.12, après 3.14, joué en 4.2
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
  // 3.12 : assert_export_no_secret (INV5, INV8 : fichier, journal du serveur, audit, import sans session ni secret) est dans
  // apps/server/src/portability.integration.test.ts.
  test.todo("assert_budget_and_stop_controls — Chromium (Playwright) : attempt.finished émis → [data-testid=attempt] visible en moins de 2 s"); // 06 § 4.3, tâche(s) 3.6 (3.5 : rendu SSR, sans navigateur)
  test.todo("assert_run_detail_error_open"); // 06 § 4.3 : écran Détail d'un run, confié à aucune tâche (ADR 0003 : 3.4 ou tâche nouvelle), E2E 3.6
  // 2.16 (D-49, mode « SYM ne lâche pas ») : décisions pures dans packages/core/src/persistence/persistence.unit.test.ts, base et
  // horloge simulée dans packages/db/src/persistence.integration.test.ts, modèle de la machine dans machine.prop.test.ts, route
  // PATCH /api/apis/{slug} et état Api.persistence dans apps/server/src/rest.integration.test.ts. Reste le volet console :
  test.todo("assert_persistence_schedule_and_caps — volet console : interrupteur (libellé PERSISTENCE_SWITCH_COPY) et état Api.persistence (prochain essai, dépense) sur la fiche API, récit narrative.persistence.*"); // D-49, tâche(s) 3.5 + 3.17 (3.17 non fusionnée), joué en 4.2
  // 3.9 : assert_a11y_axe_clean, assert_keyboard_only_path, assert_live_regions_plan sont jugés en Chromium (apps/web/e2e/*.e2e.ts,
  // pnpm test:e2e) et leur couverture est gardée par apps/web/src/a11y.unit.test.ts ; 3.6 les rejoue sur l'instance réelle.
  // 4.11 (V1.1) : le replay de la démo de la landing est écrit à la main en V1 ; sa génération depuis l'enregistrement d'enquête de la démo sans clé suit M2.
  test.todo("assert_landing_demo_matches_recording"); // 22 § 2.4, V1.1
});
