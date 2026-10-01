-- SPDX-License-Identifier: AGPL-3.0-only
-- 0006_failure_class_unify : une seule énumération FailureClass (04b § 1, 04 §7), source @runtime/core model/enums.ts.
-- runs.failure_class était déjà alignée (0001). run_attempts.result_class n'avait aucun CHECK : on lui impose
-- `ok` + la même liste fermée + le même motif llm_* (ATTEMPT_RESULTS, db/src/enums.integration.test.ts).
-- Les codes de raison de transition (challenge_in_tunnel, proxy_not_configured, tunnel_offline) ne sont pas des
-- classes : ils vont dans status_events.reason / apis.status_reason, jamais ici.
ALTER TABLE run_attempts
  ADD CONSTRAINT run_attempts_result_class_check CHECK (result_class IN (
    'ok', 'transient', 'network', 'rate_limited', 'forbidden', 'blocked_by_protection', 'robots_disallowed',
    'robots_unreachable', 'payment_required', 'auth_required', 'account_limit', 'not_found', 'extraction',
    'code_error', 'run_budget_exceeded', 'budget_exceeded') OR result_class ~ '^llm_[a-z0-9_]+$');
