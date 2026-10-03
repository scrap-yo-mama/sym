-- SPDX-License-Identifier: AGPL-3.0-only
-- 0021_i18n : multilingue (tâche 3.20, 21b § 1, arbitrages du 2026-10-01 ; exception de 10-taches « garde-fous »).
--   users.locale        la liste fermée ('en', 'fr') de la CHECK est remplacée par un format : la liste des langues est
--                       `registry.json` (21 § 2), ajouter une langue ne demande aucune migration (M14). Le registre valide.
--   users.timezone      fuseau IANA, nullable, initialisé par le navigateur à la première connexion. Donnée personnelle
--                       (indice de localisation) : inventaire RGPD, export et effacement (17 § 6) ; jamais dans un journal,
--                       un webhook ni une requête vers un site cible. Valeur contrôlée contre Intl.supportedValuesOf par
--                       le serveur ; ici seulement la forme. `timezone_initialized` marque la première écriture (toute
--                       écriture du fuseau, même `null`) : la console n'initialise plus jamais ensuite.
--   invitations.locale  langue choisie par l'invitant, copiée dans users.locale à l'acceptation. Non nulle, défaut 'en'
--                       (additif : une image N-1 qui insère sans la colonne reste valable, 14 § 6).
--   runs.locale         users.locale de l'appelant au lancement (propriétaire de la planification pour un run planifié) ;
--                       sert seulement à la prose du LLM, jamais à une requête vers un site cible. Posée par un déclencheur
--                       quand l'insertion ne la fournit pas : `runtime_app` n'a pas accès à `users` (identité système).
--   settings            clé `default_locale` (langue d'instance) : aucune donnée n'est écrite ici (une montée de version ne change aucune
--                       donnée existante). L'application l'écrit au premier démarrage ; sans elle, la langue de l'owner en tient lieu.

ALTER TABLE users DROP CONSTRAINT users_locale_check;
ALTER TABLE users ADD CONSTRAINT users_locale_format CHECK (locale ~ '^[a-z]{2,3}$');
ALTER TABLE users ADD COLUMN timezone text
  CONSTRAINT users_timezone_format CHECK (timezone IS NULL OR timezone ~ '^[A-Za-z0-9_+/-]{1,64}$');
-- Le fuseau est initialisé UNE fois (première connexion) : un fuseau effacé volontairement dans Mon compte reste effacé.
ALTER TABLE users ADD COLUMN timezone_initialized boolean NOT NULL DEFAULT false;

ALTER TABLE invitations ADD COLUMN locale text NOT NULL DEFAULT 'en'
  CONSTRAINT invitations_locale_format CHECK (locale ~ '^[a-z]{2,3}$');

ALTER TABLE runs ADD COLUMN locale text;
UPDATE runs r SET locale = COALESCE((SELECT u.locale FROM users u WHERE u.id = r.owner_id), 'en');
ALTER TABLE runs ALTER COLUMN locale SET NOT NULL;
ALTER TABLE runs ADD CONSTRAINT runs_locale_format CHECK (locale ~ '^[a-z]{2,3}$');

CREATE FUNCTION runs_set_locale() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.locale IS NULL THEN
    SELECT u.locale INTO NEW.locale FROM users u WHERE u.id = NEW.owner_id;
    NEW.locale := COALESCE(NEW.locale, 'en');
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION runs_set_locale() FROM PUBLIC;
CREATE TRIGGER runs_set_locale BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION runs_set_locale();
