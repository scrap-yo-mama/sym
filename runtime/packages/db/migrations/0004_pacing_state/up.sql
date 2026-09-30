-- 0004_pacing_state : cadence par domaine distribuée (tâche 1.9, 04 §7, 17 cadence, O6 § 06).
-- La clé reste le domaine seul (assert_pacing_key_is_domain). Colonnes ajoutées à domain_pacing_state :
--   min_delay_ms         dernier délai effectif appliqué (information, métriques) ;
--   adaptive_delay_ms    ralentissement adaptatif : double à chaque refus ; décroît par paliers (calm_successes, adaptive_changed_at) ;
--   calm_successes       succès consécutifs depuis le dernier refus ou palier ;
--   adaptive_changed_at  dernier refus ou dernier palier de décroissance (durée calme) ;
--   penalty_until        aucun créneau avant cette date (429, Retry-After) ;
--   circuit_open_until   le disjoncteur ouvert passe en demi-ouvert à cette date ;
--   circuit_trips        ouvertures successives sans succès (délai croissant) ;
--   probe_started_at     requête d'essai du demi-ouvert en cours (une seule à la fois) ;
--   window_*             budget de retries : réessais / requêtes sur la fenêtre.
ALTER TABLE domain_pacing_state
  ADD COLUMN min_delay_ms integer NOT NULL DEFAULT 1500 CHECK (min_delay_ms >= 0),
  ADD COLUMN adaptive_delay_ms integer NOT NULL DEFAULT 0 CHECK (adaptive_delay_ms >= 0),
  ADD COLUMN calm_successes integer NOT NULL DEFAULT 0 CHECK (calm_successes >= 0),
  ADD COLUMN adaptive_changed_at timestamptz,
  ADD COLUMN penalty_until timestamptz,
  ADD COLUMN circuit_open_until timestamptz,
  ADD COLUMN circuit_trips integer NOT NULL DEFAULT 0 CHECK (circuit_trips >= 0),
  ADD COLUMN probe_started_at timestamptz,
  ADD COLUMN window_started_at timestamptz,
  ADD COLUMN window_requests integer NOT NULL DEFAULT 0 CHECK (window_requests >= 0),
  ADD COLUMN window_retries integer NOT NULL DEFAULT 0 CHECK (window_retries >= 0);
