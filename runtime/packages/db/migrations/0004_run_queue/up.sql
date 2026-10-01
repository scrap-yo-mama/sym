-- 1.3 (INV4, T2 R2 et R4) : lien run ↔ job pg-boss et reprise après la perte d'un worker.
-- `job_id` : job pg-boss courant du run, écrit dans la même transaction que le job. C'est aussi le jeton de clôture :
--   le worker ne met à jour un run que si `job_id` est toujours le sien ; une remise en file change `job_id`, donc un
--   worker présumé mort qui se réveille n'écrit plus rien.
-- `worker_id` : worker qui tient le run (`worker_heartbeats.worker_id`), informatif.
-- `requeue_count` : remises en file après perte du worker (plafond : 1 en lecture, 0 si `allow_write_actions`).
ALTER TABLE runs
  ADD COLUMN job_id uuid,
  ADD COLUMN worker_id text,
  ADD COLUMN requeue_count integer NOT NULL DEFAULT 0 CHECK (requeue_count >= 0);
