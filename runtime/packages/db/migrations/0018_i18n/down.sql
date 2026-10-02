-- SPDX-License-Identifier: AGPL-3.0-only
-- Retour de 0018_i18n. Les langues autres que en et fr sont ramenées à `en` avant de restaurer la liste fermée.
DROP TRIGGER runs_set_locale ON runs;
DROP FUNCTION runs_set_locale();
ALTER TABLE runs DROP COLUMN locale;
ALTER TABLE invitations DROP COLUMN locale;
ALTER TABLE users DROP COLUMN timezone_initialized;
ALTER TABLE users DROP COLUMN timezone;
UPDATE users SET locale = 'en' WHERE locale NOT IN ('en', 'fr');
ALTER TABLE users DROP CONSTRAINT users_locale_format;
ALTER TABLE users ADD CONSTRAINT users_locale_check CHECK (locale IN ('en', 'fr'));
