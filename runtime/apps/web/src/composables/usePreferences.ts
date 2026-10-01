// SPDX-License-Identifier: AGPL-3.0-only
// Langue et thème de l'interface. Priorité : choix explicite mémorisé dans le navigateur, puis préférence du compte
// (`GET /api/me`, `users.locale` et `users.theme`), puis langue et thème du système. Un changement est mémorisé
// localement ; son écriture sur le compte vient avec l'écran Mon compte (tâche 3.8), d'où cette priorité : sans elle,
// un choix fait dans l'en-tête serait perdu au rechargement.
import { ref, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { LOCALE_STORAGE_KEY, normalizeLocale, setLocale, type Locale, type LocaleTarget } from '@/i18n';
import { applyMotion, readStoredMotion, storeMotion, type Motion } from '@/lib/motion';
import { applyTheme, isTheme, readStoredTheme, storeTheme, THEME_STORAGE_KEY, type Theme } from '@/lib/theme';

export const theme: Ref<Theme> = ref(readStoredTheme());
/** Réglage Animations (20 § 4.3) : mémorisé dans ce navigateur, `users.motion` étant « à valider » (20b § 5). */
const motion: Ref<Motion> = ref(readStoredMotion());

function hasStored(key: string): boolean {
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

export function usePreferences() {
  const i18n = useI18n();

  async function changeLocale(next: Locale): Promise<void> {
    await setLocale(i18n, next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* stockage indisponible : le choix vaut pour la session */
    }
  }

  function changeTheme(next: Theme): void {
    theme.value = next;
    storeTheme(next);
    applyTheme(next);
  }

  function changeMotion(next: Motion): void {
    motion.value = next;
    storeMotion(next);
    applyMotion(next);
  }

  return { changeLocale, changeMotion, changeTheme, motion, theme };
}

/** Applique la préférence du compte reçue à la connexion, sauf si l'utilisateur a déjà fait un choix explicite ici. */
export async function applyAccountPreferences(target: LocaleTarget, account: { locale: string; theme: string }): Promise<void> {
  if (!hasStored(LOCALE_STORAGE_KEY)) await setLocale(target, normalizeLocale(account.locale));
  if (!hasStored(THEME_STORAGE_KEY) && isTheme(account.theme)) {
    theme.value = account.theme;
    applyTheme(account.theme);
  }
}
