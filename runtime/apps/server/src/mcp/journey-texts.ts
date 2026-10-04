// SPDX-License-Identifier: AGPL-3.0-only
// Textes du parcours « du premier coup » (lot A du CDC UX, 03-specs-mcp, 08-specs-voix) : jalons de progression, en-tête de
// résultat, question unique, suites d'une réponse, phrase d'une demande déjà connue. Deux langues (`en`, `fr`), choisies
// comme le reste du MCP (`?lang=`, puis le compte). Gabarits FERMÉS : des nombres, des coûts, des noms de champs du schéma ;
// jamais un texte du site. Le lot « textes » (U1.7, U1.8) reprendra ces gabarits dans `packages/i18n` sans changer les appelants.
import { fmtUsd, type McpLocale } from './texts.js';

type Plural = (n: number) => string;

/** « 1 élément » / « 519 éléments », « 1 item » / « 519 items ». */
const items: Record<McpLocale, Plural> = {
  fr: (n) => `${n} élément${n === 1 ? '' : 's'}`,
  en: (n) => `${n} item${n === 1 ? '' : 's'}`,
};

const list = (names: readonly string[], locale: McpLocale): string => names.map((n) => (locale === 'fr' ? `« ${n} »` : `"${n}"`)).join(', ');

export type JourneyTexts = {
  /** Progression : « 2/4 Reconnaître · 12 s » (jalon du noyau, durée mesurée). */
  heartbeat: (step: number, label: string, elapsedS: number) => string;
  /** Fin sur succès : signature, total et coût d'un rejeu. */
  done: (total: number, replayUsd: number) => string;
  /** Aperçu : « Les 10 premiers éléments sur 519 : » */
  preview: (shown: number, total: number) => string;
  moreItems: (ids: string) => string;
  empty: string;
  /** Demande identique déjà connue (UXI8). */
  existing: string;
  /** Suite après un échec, selon le statut de l'API. */
  failedNext: { retry: string; console: string; none: string };
  /** Question unique et fermée (§ 4 et § 9) : texte, puis options numérotées. */
  question: {
    multipleLists: (chosen: number, other: number) => { text: string; chosen: string; other: string };
    requestedMissing: (fields: readonly string[]) => { text: string; carryOn: string; details: string };
    exampleMismatch: (fields: readonly string[]) => { text: string; carryOn: string; other: string };
    cost: (estimateUsd: number, compileUsd: number) => { text: string; carryOn: string; cancel: string };
    /** « 1) … 2) … ; autre : ajoute une remarque. » */
    render: (text: string, options: readonly string[]) => string;
    reply: (tool: string) => string;
  };
  /** Suites d'une réponse `choice` autre que « continuer ». */
  choice: {
    declined: string;
    rerun: (what: string) => string;
    unknown: (valid: string) => string;
  };
};

const FR: JourneyTexts = {
  heartbeat: (step, label, s) => `${step}/4 ${label} · ${s} s`,
  done: (total, usd) => `SYM 👻 : C’est fait. ${items.fr(total)}, ${fmtUsd(usd, 'fr')} par rejeu.`,
  preview: (shown, total) => (shown >= total ? `Les ${items.fr(shown)} :` : `Les ${shown} premiers éléments sur ${total} :`),
  moreItems: (ids) => `Le reste se lit avec get_items (${ids}).`,
  empty: 'Aucun élément pour l’instant.',
  existing: 'SYM 👻 : Je travaille déjà sur cette demande.',
  failedNext: {
    retry: 'Pour réessayer toi-même : ré-enquête avec run_api (force_investigate) ; ne relance pas create_api.',
    console: 'Cette suite se fait dans la console.',
    none: 'Dis à l’utilisateur ce qui s’est passé et demande-lui comment continuer.',
  },
  question: {
    multipleLists: (a, b) => ({
      text: `J’ai trouvé deux listes. Laquelle ?`,
      chosen: `La liste proposée (${items.fr(a)})`,
      other: `L’autre liste (${items.fr(b)})`,
    }),
    requestedMissing: (fields) => ({
      text: `Je ne trouve pas ${fields.length === 1 ? 'ce champ' : 'ces champs'} sur ces pages : ${list(fields, 'fr')}.`,
      carryOn: 'Continuer sans',
      details: 'Regarder aussi les pages de détail',
    }),
    exampleMismatch: (fields) => ({
      text: `Ton exemple ${fields.length === 1 ? 'a un champ' : 'a des champs'} que je ne vois pas : ${list(fields, 'fr')}.`,
      carryOn: 'Continuer sans',
      other: 'Autre (ajoute une remarque)',
    }),
    cost: (estimate, compile) => ({
      text: `Les essais coûteraient environ ${fmtUsd(estimate, 'fr')}${compile > 0 ? ` (dont ${fmtUsd(compile, 'fr')} de compilation)` : ''}. On lance ?`,
      carryOn: `Lancer les essais (~${fmtUsd(estimate, 'fr')})`,
      cancel: 'Ne rien lancer',
    }),
    render: (text, options) => `${text} ${options.map((o, i) => `${i + 1}) ${o}`).join(' ')}`,
    reply: (tool) => `Réponds avec ${tool} et choice (l’identifiant de l’option).`,
  },
  choice: {
    declined: 'SYM 👻 : D’accord, je ne lance rien. Rien n’a été dépensé pour les essais.',
    rerun: (what) => `SYM 👻 : Noté (${what}). Je repars d’une nouvelle demande avec cette précision ; l’ancienne reste dans le catalogue.`,
    unknown: (valid) => `Cette option n’existe pas. Options : ${valid}.`,
  },
};

const EN_TEXTS: JourneyTexts = {
  heartbeat: (step, label, s) => `${step}/4 ${label} · ${s} s`,
  done: (total, usd) => `SYM 👻: Done. ${items.en(total)}, ${fmtUsd(usd, 'en')} per replay.`,
  preview: (shown, total) => (shown >= total ? `The ${items.en(shown)}:` : `The first ${shown} of ${total} items:`),
  moreItems: (ids) => `Read the rest with get_items (${ids}).`,
  empty: 'No item yet.',
  existing: 'SYM 👻: I am already working on this request.',
  failedNext: {
    retry: 'To try again yourself: investigate again with run_api (force_investigate); do not call create_api again.',
    console: 'This next step is done in the console.',
    none: 'Tell the user what happened and ask how to continue.',
  },
  question: {
    multipleLists: (a, b) => ({ text: 'I found two lists. Which one?', chosen: `The proposed list (${items.en(a)})`, other: `The other list (${items.en(b)})` }),
    requestedMissing: (fields) => ({
      text: `I cannot find ${fields.length === 1 ? 'this field' : 'these fields'} on these pages: ${list(fields, 'en')}.`,
      carryOn: 'Continue without',
      details: 'Also look at the detail pages',
    }),
    exampleMismatch: (fields) => ({
      text: `Your example has ${fields.length === 1 ? 'a field' : 'fields'} I do not see: ${list(fields, 'en')}.`,
      carryOn: 'Continue without',
      other: 'Other (add a remark)',
    }),
    cost: (estimate, compile) => ({
      text: `The trials would cost about ${fmtUsd(estimate, 'en')}${compile > 0 ? ` (${fmtUsd(compile, 'en')} of it for the compilation)` : ''}. Go ahead?`,
      carryOn: `Start the trials (~${fmtUsd(estimate, 'en')})`,
      cancel: 'Start nothing',
    }),
    render: (text, options) => `${text} ${options.map((o, i) => `${i + 1}) ${o}`).join(' ')}`,
    reply: (tool) => `Answer with ${tool} and choice (the option id).`,
  },
  choice: {
    declined: 'SYM 👻: OK, I start nothing. Nothing was spent on the trials.',
    rerun: (what) => `SYM 👻: Noted (${what}). I start again from a new request with this detail; the old one stays in the catalog.`,
    unknown: (valid) => `This option does not exist. Options: ${valid}.`,
  },
};

export const journeyTexts = (locale: McpLocale): JourneyTexts => (locale === 'fr' ? FR : EN_TEXTS);
