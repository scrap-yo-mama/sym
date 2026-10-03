-- SPDX-License-Identifier: AGPL-3.0-only
-- 0005_usage : comptage (cdc/sym-browser 04d § 4.1 et § 4.4, tâche 2.6, BINV5).
--   usage_snapshots : dernière mesure en cours poussée par le nœud (toutes les 10 s) ; si le nœud est perdu, ses sessions
--     sont closes sur cette mesure (`usage_records.source = 'reconstructed'`), puis remplacées par sa clôture réelle
--     (usage.wal) quand il revient.
--   usage_reconciliations : rapport de chaque réconciliation (écart mesuré contre usage.wal, corrections, écart restant),
--     affiché dans l'écran Consommation.
CREATE TABLE usage_snapshots (
  session_id uuid PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  node_id text NOT NULL REFERENCES nodes (id),
  started_at timestamptz NOT NULL,
  browser_ms bigint NOT NULL CHECK (browser_ms >= 0),
  bytes_in bigint NOT NULL CHECK (bytes_in >= 0),
  bytes_out bigint NOT NULL CHECK (bytes_out >= 0),
  measured_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_reconciliations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ran_at timestamptz NOT NULL DEFAULT now(),
  -- Clôtures lues dans les journaux des nœuds joignables.
  closures integer NOT NULL CHECK (closures >= 0),
  inserted integer NOT NULL CHECK (inserted >= 0),
  replaced integer NOT NULL CHECK (replaced >= 0),
  reconstructed integer NOT NULL CHECK (reconstructed >= 0),
  -- Écart avant correction : Σ |secondes facturées − ceil(durée mesurée)| et Σ |octets facturés − octets mesurés|.
  drift_seconds bigint NOT NULL CHECK (drift_seconds >= 0),
  drift_bytes bigint NOT NULL CHECK (drift_bytes >= 0),
  -- Écart après correction : 0 attendu.
  remaining_drift_seconds bigint NOT NULL CHECK (remaining_drift_seconds >= 0),
  remaining_drift_bytes bigint NOT NULL CHECK (remaining_drift_bytes >= 0)
);
CREATE INDEX usage_reconciliations_ran_idx ON usage_reconciliations (ran_at);
