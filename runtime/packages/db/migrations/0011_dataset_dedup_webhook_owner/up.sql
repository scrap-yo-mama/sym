-- SPDX-License-Identifier: AGPL-3.0-only
-- 0011_dataset_dedup_webhook_owner (tâche 2.5, correctifs de vérification ; 08 § 5, INV12) :
--   datasets.new_items                    items dont la clé de déduplication n'avait jamais été vue pour l'API
--                                         (`dedup_key`, `diff`, événement `items.new`) ;
--   webhook_subscriptions.last_failure_at dernier échec de livraison : une série d'échecs n'est « continue » (désactivation
--                                         après 5 jours) que si deux échecs ne sont jamais séparés de plus de 24 h ;
--   clés étrangères liées au propriétaire une livraison ne vise qu'une cible de SON propriétaire, une cible ne porte que
--                                         des secrets de SON propriétaire. Le contrôle de clé étrangère contourne la RLS :
--                                         sans ce lien, un membre qui connaît un UUID pourrait faire signer avec le secret
--                                         d'un autre ou livrer à la cible d'un autre.
ALTER TABLE datasets ADD COLUMN new_items integer NOT NULL DEFAULT 0 CONSTRAINT datasets_new_items_check CHECK (new_items >= 0);

ALTER TABLE webhook_subscriptions ADD COLUMN last_failure_at timestamptz;

ALTER TABLE secrets ADD CONSTRAINT secrets_id_owner_key UNIQUE (id, owner_id);
ALTER TABLE webhook_subscriptions ADD CONSTRAINT webhook_subscriptions_id_owner_key UNIQUE (id, owner_id);
-- `SET NULL (colonne)` : la suppression d'un secret vide la colonne du secret, jamais `owner_id`.
ALTER TABLE webhook_subscriptions
  ADD CONSTRAINT webhook_subscriptions_secret_owner_fkey
    FOREIGN KEY (secret_id, owner_id) REFERENCES secrets (id, owner_id) ON DELETE SET NULL (secret_id),
  ADD CONSTRAINT webhook_subscriptions_previous_secret_owner_fkey
    FOREIGN KEY (previous_secret_id, owner_id) REFERENCES secrets (id, owner_id) ON DELETE SET NULL (previous_secret_id);
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_subscription_owner_fkey
    FOREIGN KEY (subscription_id, owner_id) REFERENCES webhook_subscriptions (id, owner_id) ON DELETE CASCADE;
