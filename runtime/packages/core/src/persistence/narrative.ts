// SPDX-License-Identifier: AGPL-3.0-only
// Récit du mode « SYM ne lâche pas » (D-49, 04 §6, 19b §3) : gabarits `narrative.persistence.*`, rendus à la lecture (le
// webhook ne porte que des codes et des compteurs, jamais une phrase), et libellé de l'interrupteur qui dit aussi ce qu'il
// ne fait pas. Ces textes entrent au corpus d'`assert_brand_copy_no_bypass_promise` (3.19) : aucune promesse de
// contournement, aucun idiome d'invisibilité ; la voix est relue par 3.19 (à relire : le prochain essai dit comme 04 §6,
// « Je réessaie demain à 09:10. » — jour relatif `{when}` et heure `{time}` dans le fuseau du lecteur).
// Textes dans les catalogues communs de `@runtime/i18n` (`narrative.persistence.*`, `persistence.*`, tâche 3.20) : une
// 3e langue s'ajoute par fichiers de données, sans modifier ce module (assert_third_locale_no_code_change).
import { defaultI18n, flatten } from '@runtime/i18n';

/** Langue du lecteur : un code du registre (`@runtime/i18n`) ; une langue non livrée retombe sur `en`. */
export type PersistenceLocale = string;

/** Langues livrées (registre des langues), dans l'ordre du registre. */
export const PERSISTENCE_LOCALES: readonly PersistenceLocale[] = defaultI18n().supported;

export const PERSISTENCE_NARRATIVE_KEYS = [
  'narrative.persistence.attempt',
  'narrative.persistence.recovered',
  'narrative.persistence.stopped',
  'narrative.persistence.exhausted',
] as const;
export type PersistenceNarrativeKey = (typeof PERSISTENCE_NARRATIVE_KEYS)[number];

const STOP_REASON_CODES = ['refused', 'ineligible', 'prior_refusal', 'geo_restricted', 'negative_memory_unavailable'] as const;

/** Message brut d'une clé dans une langue (repli `en`), variables comprises : pour les corpus et les tests de parité. */
function raw(key: string, locale: PersistenceLocale): string {
  const { catalogs } = defaultI18n();
  return flatten(catalogs[locale] ?? {}).get(key) ?? flatten(catalogs['en'] ?? {}).get(key) ?? '';
}

const lang = (locale: PersistenceLocale): PersistenceLocale => (PERSISTENCE_LOCALES.includes(locale) ? locale : 'en');
const text = (key: string, locale: PersistenceLocale, params: Record<string, string> = {}): string => defaultI18n().renderer.render(key, params, lang(locale));

/** Gabarits bruts par langue livrée (`{sym}`, `{when}`, `{time}`, `{api}`, `{reason}` non rendus). */
export const PERSISTENCE_NARRATIVE: Readonly<Record<PersistenceLocale, Readonly<Record<PersistenceNarrativeKey, string>>>> = Object.fromEntries(
  PERSISTENCE_LOCALES.map((l) => [l, Object.fromEntries(PERSISTENCE_NARRATIVE_KEYS.map((k) => [k, raw(k, l)])) as Record<PersistenceNarrativeKey, string>]),
);

/** Libellé et aide de l'interrupteur (fiche API) : ce que le mode fait, et ce qu'il ne fait jamais. */
export const PERSISTENCE_SWITCH_COPY: Readonly<Record<PersistenceLocale, { readonly label: string; readonly help: string }>> = Object.fromEntries(
  PERSISTENCE_LOCALES.map((l) => [l, { label: text('persistence.switch.label', l), help: text('persistence.switch.help', l) }]),
);

/** Tous les textes du mode, pour les gardes de vocabulaire (INV6, 20 §2). */
export function persistenceCopyCorpus(): string[] {
  return PERSISTENCE_LOCALES.flatMap((l) => [
    ...PERSISTENCE_NARRATIVE_KEYS.map((k) => raw(k, l)),
    raw('persistence.switch.label', l),
    raw('persistence.switch.help', l),
    ...STOP_REASON_CODES.map((code) => raw(`persistence.reason.${code}`, l)),
  ]);
}

/** Jour civil (AAAA-MM-JJ) d'un instant dans un fuseau. */
function civilDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** `{when}` et `{time}` du prochain essai, vus du lecteur (`now`, fuseau `timeZone`, UTC par défaut). */
function persistenceRetryWhen(locale: PersistenceLocale, nextAt: Date, now: Date, timeZone = 'UTC'): { when: string; time: string } {
  const day = civilDay(nextAt, timeZone);
  const today = civilDay(now, timeZone);
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const tomorrow = civilDay(new Date(Date.UTC(y, m - 1, d + 1, 12)), 'UTC');
  const when =
    day === today ? text('persistence.when.today', locale)
    : day === tomorrow ? text('persistence.when.tomorrow', locale)
    : text('persistence.when.on', locale, { date: new Intl.DateTimeFormat(lang(locale), { timeZone, day: '2-digit', month: '2-digit' }).format(nextAt) });
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(nextAt);
  return { when, time };
}

type PersistenceNarrativeParams = {
  /** Prochain essai (`narrative.persistence.attempt`), dit en jour relatif et heure locale, jamais en date ISO brute. */
  nextAt?: Date;
  /** Instant de lecture (défaut : maintenant) et fuseau du lecteur (défaut : UTC). */
  now?: Date;
  timeZone?: string;
  api?: string;
  reason?: string;
};

/** Rendu d'un gabarit. `reason` : code (`refused`, `ineligible`, `prior_refusal`…), traduit ; `api` inséré tel quel. */
export function renderPersistenceNarrative(locale: PersistenceLocale, key: PersistenceNarrativeKey, params: PersistenceNarrativeParams = {}): string {
  const code = params.reason === undefined ? undefined : (STOP_REASON_CODES as readonly string[]).includes(params.reason) ? params.reason : 'ineligible';
  const retry = params.nextAt === undefined ? undefined : persistenceRetryWhen(locale, params.nextAt, params.now ?? new Date(), params.timeZone);
  const values: Record<string, string> = {
    ...(retry === undefined ? {} : { when: retry.when, time: retry.time }),
    ...(params.api === undefined ? {} : { api: params.api }),
    ...(code === undefined ? {} : { reason: text(`persistence.reason.${code}`, locale) }),
  };
  return text(key, locale, values);
}
