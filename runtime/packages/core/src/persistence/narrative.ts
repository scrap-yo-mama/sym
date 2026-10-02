// SPDX-License-Identifier: AGPL-3.0-only
// Récit du mode « SYM ne lâche pas » (D-49, 04 §6, 19b §3) : gabarits `narrative.persistence.*` en `en` et `fr`, rendus à
// la lecture (le webhook ne porte que des codes et des compteurs, jamais une phrase), et libellé de l'interrupteur qui dit
// aussi ce qu'il ne fait pas. Ces textes entrent au corpus d'`assert_brand_copy_no_bypass_promise` (3.19) : aucune
// promesse de contournement, aucun idiome d'invisibilité ; la voix est relue par 3.19.

export const PERSISTENCE_LOCALES = ['en', 'fr'] as const;
export type PersistenceLocale = (typeof PERSISTENCE_LOCALES)[number];

export const PERSISTENCE_NARRATIVE_KEYS = [
  'narrative.persistence.attempt',
  'narrative.persistence.recovered',
  'narrative.persistence.stopped',
  'narrative.persistence.exhausted',
] as const;
export type PersistenceNarrativeKey = (typeof PERSISTENCE_NARRATIVE_KEYS)[number];

export const PERSISTENCE_NARRATIVE: Readonly<Record<PersistenceLocale, Readonly<Record<PersistenceNarrativeKey, string>>>> = {
  en: {
    'narrative.persistence.attempt': 'SYM 👻: Still in error. I will try again on {date}.',
    'narrative.persistence.recovered': 'SYM 👻: I did not give up: {api} is healthy again.',
    'narrative.persistence.stopped': 'SYM 👻: I am no longer retrying ({reason}). Nothing will restart on its own.',
    'narrative.persistence.exhausted': 'SYM 👻: The cap or the duration of “SYM never gives up” has been reached: no more automatic attempts.',
  },
  fr: {
    'narrative.persistence.attempt': 'SYM 👻 : Toujours en erreur. Je réessaie le {date}.',
    'narrative.persistence.recovered': 'SYM 👻 : Je n’ai pas lâché : {api} est de nouveau saine.',
    'narrative.persistence.stopped': 'SYM 👻 : J’arrête de réessayer ({reason}). Rien ne repartira seul.',
    'narrative.persistence.exhausted': 'SYM 👻 : Plafond ou durée du mode « SYM ne lâche pas » atteint : plus d’essai automatique.',
  },
};

/** Libellé et aide de l'interrupteur (fiche API) : ce que le mode fait, et ce qu'il ne fait jamais. */
export const PERSISTENCE_SWITCH_COPY: Readonly<Record<PersistenceLocale, { readonly label: string; readonly help: string }>> = {
  en: { label: 'SYM never gives up', help: 'Retry on its own while the API is in error. Never after a refusal, a challenge or a required login.' },
  fr: { label: 'SYM ne lâche pas', help: 'Réessayer seul quand l’API est en erreur. Jamais après un refus, un défi ou une connexion requise.' },
};

/** Raisons d'arrêt dites en clair (`{reason}` de `narrative.persistence.stopped`) ; un code inconnu reste générique. */
const STOP_REASONS: Readonly<Record<PersistenceLocale, Readonly<Record<string, string>>>> = {
  en: {
    refused: 'the site said no',
    ineligible: 'this outcome is not retried',
    prior_refusal: 'the site already said no',
    geo_restricted: 'the site is not available from here',
    negative_memory_unavailable: 'the refusal memory is not available',
  },
  fr: {
    refused: 'le site a dit non',
    ineligible: 'cette issue ne se réessaie pas',
    prior_refusal: 'le site a déjà dit non',
    geo_restricted: 'le site n’est pas accessible d’ici',
    negative_memory_unavailable: 'la mémoire des refus n’est pas disponible',
  },
};

/** Tous les textes du mode, pour les gardes de vocabulaire (INV6, 20 §2). */
export function persistenceCopyCorpus(): string[] {
  return PERSISTENCE_LOCALES.flatMap((l) => [
    ...Object.values(PERSISTENCE_NARRATIVE[l]),
    PERSISTENCE_SWITCH_COPY[l].label,
    PERSISTENCE_SWITCH_COPY[l].help,
    ...Object.values(STOP_REASONS[l]),
  ]);
}

/** Rendu d'un gabarit. `reason` : code (`refused`, `ineligible`, `prior_refusal`…), traduit ; les autres valeurs sont insérées telles quelles. */
export function renderPersistenceNarrative(locale: PersistenceLocale, key: PersistenceNarrativeKey, params: { date?: string; api?: string; reason?: string } = {}): string {
  const reasons = STOP_REASONS[locale];
  const reason = params.reason === undefined ? undefined : (reasons[params.reason] ?? reasons['ineligible']!);
  const values: Record<string, string | undefined> = { date: params.date, api: params.api, reason };
  return PERSISTENCE_NARRATIVE[locale][key].replace(/\{(date|api|reason)\}/g, (whole, name: string) => values[name] ?? whole);
}
