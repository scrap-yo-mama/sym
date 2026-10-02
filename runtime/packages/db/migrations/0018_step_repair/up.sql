-- SPDX-License-Identifier: AGPL-3.0-only
-- 0018_step_repair (tâche 2.13, 19 §4, 19b §1 ; migration validée par l'arbitrage du 2026-10-01) : reprise par étape et
-- mode « agent instruit ».
--   apis.instructed_mode                  opt-in EXPLICITE par API (défaut faux) ; vrai seulement si la version courante
--                                         est non compilable et que ses étapes instruites ont été confirmées par un
--                                         humain sur leur empreinte exacte (déclencheur `apis_instructed_mode_guard`,
--                                         en plus du code) ;
--   strategy_versions.compilable          yes | unknown | no (une trace E6 non compilable en E5 : `no`) ;
--   strategy_versions.instructed_steps    intentions et `post`, sans `target` (non fiables tant que non confirmées) ;
--   strategy_versions.instructed_steps_sha256, instructed_steps_confirmed (by, at, sha256 : acte humain) ;
--   strategy_versions.source_steps        source des étapes (intent, pre, post) : non fiable, `post` immuable ;
--   strategy_versions.archive_reason      `repair_not_validated` : vN+1 conforme mais non validée sans agent (V5),
--                                         archivée non courante (les autres raisons de 19b §1 viennent avec 3.14) ;
--   run_attempts.step_id, step_level, step_outcome, tokens_in, tokens_out : journal par étape (coût : `cost_usd`).
-- Tout reste sous la RLS `owner_id` existante (INV12) et part avec l'API.
ALTER TABLE apis ADD COLUMN instructed_mode boolean NOT NULL DEFAULT false;

ALTER TABLE strategy_versions
  ADD COLUMN compilable text NOT NULL DEFAULT 'unknown' CHECK (compilable IN ('yes', 'unknown', 'no')),
  ADD COLUMN instructed_steps jsonb CHECK (instructed_steps IS NULL OR jsonb_typeof(instructed_steps) = 'array'),
  ADD COLUMN instructed_steps_sha256 text CHECK (instructed_steps_sha256 IS NULL OR instructed_steps_sha256 ~ '^[a-f0-9]{64}$'),
  ADD COLUMN instructed_steps_confirmed jsonb CHECK (instructed_steps_confirmed IS NULL OR jsonb_typeof(instructed_steps_confirmed) = 'object'),
  ADD COLUMN archive_reason text CHECK (archive_reason IN ('repair_not_validated')),
  -- `source.steps` de 19b §1 (intent, pre, post[] marqués derived_from_untrusted) : rejoindra la `source` de 2.10.
  ADD COLUMN source_steps jsonb CHECK (source_steps IS NULL OR jsonb_typeof(source_steps) = 'array');

ALTER TABLE run_attempts
  ADD COLUMN step_id text CHECK (step_id IS NULL OR step_id ~ '^[A-Za-z0-9_-]{1,40}$'),
  ADD COLUMN step_level smallint CHECK (step_level BETWEEN 1 AND 3),
  ADD COLUMN step_outcome text CHECK (step_outcome IN ('replayed', 'alternate', 'agent_repaired', 'failed')),
  ADD COLUMN tokens_in bigint NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  ADD COLUMN tokens_out bigint NOT NULL DEFAULT 0 CHECK (tokens_out >= 0);

-- Mode « agent instruit » : jamais vrai sans étapes instruites confirmées par un humain sur la version courante (19 §4).
-- Le code (`setInstructedMode`) refuse avant ; ce déclencheur couvre toute autre écriture (SQL brut, autre module).
CREATE FUNCTION apis_instructed_mode_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.instructed_mode AND NOT EXISTS (
    SELECT 1 FROM strategy_versions s
     WHERE s.api_id = NEW.id AND s.version = NEW.current_strategy_version
       AND s.compilable <> 'yes'
       AND s.instructed_steps IS NOT NULL AND jsonb_array_length(s.instructed_steps) > 0
       AND s.instructed_steps_sha256 IS NOT NULL
       AND s.instructed_steps_confirmed ->> 'by' IS NOT NULL
       AND s.instructed_steps_confirmed ->> 'at' IS NOT NULL
       AND s.instructed_steps_confirmed ->> 'sha256' = s.instructed_steps_sha256
  ) THEN
    RAISE EXCEPTION 'instructed_mode : étapes instruites non confirmées par un humain sur la version courante'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'apis_instructed_mode_guard';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER apis_instructed_mode_guard
  BEFORE INSERT OR UPDATE OF instructed_mode, current_strategy_version ON apis
  FOR EACH ROW WHEN (NEW.instructed_mode) EXECUTE FUNCTION apis_instructed_mode_guard();

-- Étapes instruites changées après confirmation (réparation, affinage) : la confirmation ne vaut plus, le mode retombe.
CREATE FUNCTION strategy_versions_instructed_reset() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.instructed_steps_sha256 IS DISTINCT FROM OLD.instructed_steps_sha256 THEN
    NEW.instructed_steps_confirmed := NULL;
    UPDATE apis SET instructed_mode = false WHERE id = NEW.api_id AND current_strategy_version = NEW.version AND instructed_mode;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER strategy_versions_instructed_reset
  BEFORE UPDATE OF instructed_steps, instructed_steps_sha256 ON strategy_versions
  FOR EACH ROW EXECUTE FUNCTION strategy_versions_instructed_reset();
