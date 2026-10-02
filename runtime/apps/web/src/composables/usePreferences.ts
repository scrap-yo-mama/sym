// SPDX-License-Identifier: AGPL-3.0-only
// Langue, fuseau et thème de l'interface (21 § 3). Langue : celle du COMPTE gagne dès qu'il y en a un (`users.locale`) ; avant la
// connexion, le choix mémorisé dans ce navigateur (équivalent du cookie `sym_locale`), puis la langue du navigateur. Un
// changement de langue connecté est écrit sur le compte (`PATCH /api/me`) : il ne se perd plus au rechargement et suit la
// personne d'un navigateur à l'autre. Le fuseau (`users.timezone`) est posé une fois, à la première connexion, par celui du
// navigateur ; il se modifie dans Mon compte. Thème : choix mémorisé ici d'abord, puis préférence du compte.
import { ref, type Ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { components } from '@runtime/client';
import { isValidTimeZone } from '@runtime/i18n/browser';
import { LOCALE_STORAGE_KEY, normalizeLocale, setLocale, type Locale, type LocaleTarget } from '@/i18n';
import { getApi } from '@/lib/api';
import { call, type CallResult } from '@/lib/api-call';
import { setMe, useSession } from '@/composables/useSession';
import { setDisplayTimeZone } from '@/lib/format';
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

/** Écrit langue et/ou fuseau sur le compte (`PATCH /api/me`) et met l'identité de la console à jour. */
export async function persistPreferences(body: { locale?: string; timezone?: string | null }): Promise<CallResult<components['schemas']['Me']>> {
  const result = await call(() => getApi().PATCH('/api/me', { body }));
  if (result.ok) {
    setMe(result.data);
    setDisplayTimeZone(result.data.timezone);
  }
  return result;
}

export function usePreferences() {
  const i18n = useI18n();
  const { isAuthenticated } = useSession();

  async function changeLocale(next: Locale): Promise<void> {
    await setLocale(i18n, next);
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      /* stockage indisponible : le choix vaut pour la session */
    }
    if (isAuthenticated.value) await persistPreferences({ locale: next });
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

/** Fuseau IANA du navigateur, s'il est reconnu (jamais déduit de la langue). */
function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/**
 * Applique les préférences du compte reçues à la connexion : la langue du compte l'emporte (21 § 3), le thème reste celui
 * choisi ici s'il y en a un. Première connexion (fuseau jamais initialisé) : le fuseau du navigateur est enregistré une fois.
 */
export async function applyAccountPreferences(
  target: LocaleTarget,
  account: { locale: string; theme: string; timezone?: string | null; timezoneInitialized?: boolean },
): Promise<void> {
  await setLocale(target, normalizeLocale(account.locale));
  setDisplayTimeZone(account.timezone);
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, normalizeLocale(account.locale));
  } catch {
    /* stockage indisponible */
  }
  if (!hasStored(THEME_STORAGE_KEY) && isTheme(account.theme)) {
    theme.value = account.theme;
    applyTheme(account.theme);
  }
  // Initialisation marquée par le serveur (`users.timezone_initialized`), pas « fuseau null » : un fuseau effacé dans Mon compte
  // reste effacé. Champ absent (serveur d'avant le marqueur) : aucune écriture.
  if (account.timezoneInitialized === false && (account.timezone ?? null) === null) {
    const zone = browserTimeZone();
    if (zone !== null) await persistPreferences({ timezone: zone });
  }
}
