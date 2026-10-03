// SPDX-License-Identifier: AGPL-3.0-only
// Textes MCP côté utilisateur (tâche 3.10, 05 § 1.3, 21 § 4.3, D-51) : récit de l'enquête, élicitation, titres et
// descriptions des prompts, gabarits FERMÉS des statuts `bloquee` et `action_requise` (06 « Panneau Bloquée », « Action
// requise »). Deux langues, `en` et `fr`, résolues par `?lang=` puis par la langue du compte propriétaire de la clé.
//
// Écart D-51 : `packages/i18n` (tâche 3.20) n'existe pas encore ; ce module est le catalogue provisoire du MCP, rangé sous
// les mêmes espaces de noms (`narrative.*`, `mcp.user.*`) pour que 3.20 le déplace sans changer les appelants.
//
// Règles : jamais un texte du site, d'un dossier ou d'une API dans un gabarit (seuls des codes, des comptes, des durées, des
// coûts et des noms de la liste fermée y entrent) ; aucun verbe de contournement (`assert_blocked_message_templates`).
export const MCP_LOCALES = ['en', 'fr'] as const;
export type McpLocale = (typeof MCP_LOCALES)[number];

/** Langue demandée par `?lang=` (`en`, `fr`, avec ou sans région) ; null si absente ou inconnue. */
export function parseLang(raw: unknown): McpLocale | null {
  if (typeof raw !== 'string') return null;
  const base = raw.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return (MCP_LOCALES as readonly string[]).includes(base) ? (base as McpLocale) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Nombres
// ---------------------------------------------------------------------------------------------------------------

/** Durée en secondes, une décimale (« 0,4 s »). */
export function fmtSeconds(ms: number | null, locale: McpLocale): string {
  const text = (Math.max(0, ms ?? 0) / 1000).toFixed(1);
  return `${locale === 'fr' ? text.replace('.', ',') : text} s`;
}

/** Coût en dollars, au plus quatre décimales (« 0,002 $ », « $0.002 »), `<` sous le seuil, `0` si nul. */
export function fmtUsd(value: number | null, locale: McpLocale): string {
  const v = value ?? 0;
  const body = v === 0 ? '0' : v < 0.0001 ? '<0.0001' : String(Number(v.toFixed(4)));
  const text = locale === 'fr' ? body.replace('.', ',') : body;
  return locale === 'fr' ? `${text} $` : `$${text}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Récit (narrative.*)
// ---------------------------------------------------------------------------------------------------------------

/** E1 à E6 (04 § 1) : le code d'exécution du récit. */
export const EXECUTION_CODE: Readonly<Record<string, string>> = Object.freeze({ fetch: 'E1', fetch_in_page: 'E2', playwright: 'E3', agent_fetch: 'E4', hybrid: 'E5', agent: 'E6' });

type NarrativeCatalog = {
  title: (slug: string, domain: string | null, phase: string) => string;
  /** Pastille du rapport d'accès (D-91 : plus de section robots.txt, `allowed` ou `review`). */
  access: { allowed: string; review: string; unknown: string };
  recon: (sources: number, mode: string | null) => string;
  reconFailed: (failureClass: string) => string;
  trial: (label: string, ok: boolean, result: string, records: number | null, pages: number | null) => string;
  schema: (ok: boolean, fields: number | null) => string;
  pruned: (label: string | null, reason: string | null, count: number) => string;
  strategy: (label: string, code: string, perRun: string) => string;
  stopped: (cause: string | null) => string;
  /** Arrêt pour une cause d'action requise (contact du robot, prix du modèle…) : une tâche, pas un refus du site. */
  stoppedAction: (cause: string) => string;
  failed: (failureClass: string | null) => string;
  budget: string;
  running: string;
  cancelled: string;
  action: (cause: string) => string;
  /** `ids` : arguments de `next_action` déjà rendus (« api_id <uuid> »), ou null (le texte dit alors « cet api_id »). */
  next: { validate: (ids: string | null) => string; run: (tool: string) => string; poll: (seconds: number | null, ids: string | null) => string; items: (ids: string | null) => string; none: string; schemaRemark: (ids: string | null) => string };
  console: string;
  stepWord: string;
  costWord: string;
  brief: BriefCatalog;
  header: { restart: string };
};

type BriefCatalog = {
  /** Accusé : première ligne du récit quand un dossier est présent (« SYM 👻 : J'ai lu ton dossier… »). */
  read: (hints: number, tried: number) => string;
  title: string;
  line: (id: string, kind: string, state: string, reason: string) => string;
  states: Record<string, string>;
  more: (n: number) => string;
  breaker: string;
  questions: (n: number) => string;
};

const EN: NarrativeCatalog = {
  title: (slug, domain, phase) => `Investigation ${slug}${domain === null ? '' : ` · ${domain}`} · ${phase}`,
  access: {
    allowed: 'no signal to review',
    review: 'usage signals to review',
    unknown: 'access report recorded',
  },
  recon: (n, mode) => (n === 0 ? `no data source found${mode === null ? '' : ` (${mode})`}` : `${n} candidate data source${n === 1 ? '' : 's'}${mode === null ? '' : ` (${mode})`}`),
  reconFailed: (c) => `failed (${c})`,
  trial: (label, ok, result, records, pages) =>
    `Trial ${label}: ${ok ? 'conformant' : result}${records === null ? '' : `, ${records} item${records === 1 ? '' : 's'}`}${pages === null ? '' : `, ${pages} page${pages === 1 ? '' : 's'}`}`,
  schema: (ok, fields) => (ok ? `Output schema proposed${fields === null ? '' : `: ${fields} fields`}` : 'No usable output schema could be proposed'),
  pruned: (label, reason, count) => `Skipped ${count} more expensive trial${count === 1 ? '' : 's'}${label === null ? '' : ` after ${label}`}${reason === null ? '' : ` (${reason})`}`,
  strategy: (label, code, perRun) => `Strategy kept: ${label} (${code}, ${perRun} per run)`,
  stopped: (cause) => `The investigation stopped${cause === null ? '' : ` (${cause})`}: SYM does not try other ways to reach the site.`,
  stoppedAction: (cause) => `The investigation stopped (${cause}): an action is needed before it can resume.`,
  failed: (c) => `The investigation failed${c === null ? '' : ` (${c})`}.`,
  budget: 'The investigation budget ran out before a conformant strategy was found.',
  running: 'The investigation is running.',
  cancelled: 'The investigation was cancelled; costs already incurred remain charged.',
  action: (cause) => `Action needed (${cause}).`,
  next: {
    validate: (ids) => `Next step: show the proposed schema to the user, then call validate_schema with ${ids ?? 'this api_id'} (add output_schema only to correct it).`,
    run: (tool) => `Next step: call ${tool} with its input, or run_api.`,
    poll: (s, ids) => `Next step: call get_run with ${ids ?? 'this run_id'}${s === null ? '' : ` in about ${s} seconds`}.`,
    items: (ids) => `Next step: call get_items with ${ids ?? 'next_cursor'} for the rest.`,
    none: 'Next step: none.',
    schemaRemark: (ids) => `Next step: adjust the schema to the remark, show it to the user again, then call validate_schema with ${ids === null ? '' : `${ids} and `}output_schema.`,
  },
  console: 'Console',
  stepWord: 'Step',
  costWord: 'Cost',
  header: { restart: 'If the tool does not appear, reconnect the server.' },
  brief: {
    read: (h, t) => `SYM 👻: Read your brief: ${h} hint${h === 1 ? '' : 's'}, ${t} thing${t === 1 ? '' : 's'} already tried. I check each hint before I rely on it.`,
    title: 'Brief',
    line: (id, kind, state, reason) => `${id} ${kind}: ${state}${reason === '' ? '' : ` (${reason})`}`,
    states: { used: 'used', verified_unused: 'verified, not kept', probe_failed: 'check failed', ignored: 'ignored' },
    more: (n) => `… and ${n} more, in the console`,
    breaker: 'SYM 👻: Two hints failed: I continue without your brief.',
    questions: (n) => `${n} question${n === 1 ? '' : 's'} from your AI ${n === 1 ? 'is' : 'are'} waiting in the console`,
  },
};

const FR: NarrativeCatalog = {
  title: (slug, domain, phase) => `Enquête ${slug}${domain === null ? '' : ` · ${domain}`} · ${phase}`,
  access: {
    allowed: 'aucun signal à examiner',
    review: 'signaux d’usage à examiner',
    unknown: 'rapport d’accès enregistré',
  },
  recon: (n, mode) => (n === 0 ? `aucune source de données trouvée${mode === null ? '' : ` (${mode})`}` : `${n} source${n === 1 ? '' : 's'} de données candidate${n === 1 ? '' : 's'}${mode === null ? '' : ` (${mode})`}`),
  reconFailed: (c) => `échec (${c})`,
  trial: (label, ok, result, records, pages) =>
    `Essai ${label} : ${ok ? 'conforme' : result}${records === null ? '' : `, ${records} item${records === 1 ? '' : 's'}`}${pages === null ? '' : `, ${pages} page${pages === 1 ? '' : 's'}`}`,
  schema: (ok, fields) => (ok ? `Schéma de sortie proposé${fields === null ? '' : ` : ${fields} champs`}` : 'Aucun schéma de sortie exploitable n’a pu être proposé'),
  pruned: (label, reason, count) => `${count} essai${count === 1 ? '' : 's'} plus coûteux écarté${count === 1 ? '' : 's'}${label === null ? '' : ` après ${label}`}${reason === null ? '' : ` (${reason})`}`,
  strategy: (label, code, perRun) => `Stratégie retenue : ${label} (${code}, ${perRun} par run)`,
  stopped: (cause) => `L’enquête s’est arrêtée${cause === null ? '' : ` (${cause})`} : SYM n’essaie pas d’autre voie pour atteindre le site.`,
  stoppedAction: (cause) => `L’enquête s’est arrêtée (${cause}) : une action est attendue avant de reprendre.`,
  failed: (c) => `L’enquête a échoué${c === null ? '' : ` (${c})`}.`,
  budget: 'Le budget d’enquête est épuisé avant qu’une stratégie conforme soit trouvée.',
  running: 'L’enquête est en cours.',
  cancelled: 'L’enquête est annulée ; les coûts déjà engagés restent imputés.',
  action: (cause) => `Action attendue (${cause}).`,
  next: {
    validate: (ids) => `Prochaine étape : montre le schéma proposé à l’utilisateur, puis appelle validate_schema avec ${ids ?? 'cet api_id'} (output_schema seulement pour le corriger).`,
    run: (tool) => `Prochaine étape : appelle ${tool} avec son entrée, ou run_api.`,
    poll: (s, ids) => `Prochaine étape : appelle get_run avec ${ids ?? 'ce run_id'}${s === null ? '' : ` dans environ ${s} secondes`}.`,
    items: (ids) => `Prochaine étape : appelle get_items avec ${ids ?? 'next_cursor'} pour la suite.`,
    none: 'Prochaine étape : aucune.',
    schemaRemark: (ids) => `Prochaine étape : ajuste le schéma à la remarque, montre-le de nouveau à l’utilisateur, puis appelle validate_schema avec ${ids === null ? '' : `${ids} et `}output_schema.`,
  },
  console: 'Console',
  stepWord: 'Étape',
  costWord: 'Coût',
  header: { restart: 'Si l’outil n’apparaît pas, reconnecte le serveur.' },
  brief: {
    read: (h, t) => `SYM 👻 : J’ai lu ton dossier : ${h} indice${h === 1 ? '' : 's'}, ${t} essai${t === 1 ? '' : 's'} déjà fait${t === 1 ? '' : 's'}. Je vérifie chaque indice avant de m’y fier.`,
    title: 'Dossier',
    line: (id, kind, state, reason) => `${id} ${kind} : ${state}${reason === '' ? '' : ` (${reason})`}`,
    states: { used: 'utilisé', verified_unused: 'vérifié, non retenu', probe_failed: 'vérification échouée', ignored: 'ignoré' },
    more: (n) => `… et ${n} autres, dans la console`,
    breaker: 'SYM 👻 : Deux indices ont échoué : je continue sans ton dossier.',
    questions: (n) => `${n} question${n === 1 ? '' : 's'} de ton IA attend${n === 1 ? '' : 'ent'} dans la console`,
  },
};

export const narrativeCatalog = (locale: McpLocale): NarrativeCatalog => (locale === 'fr' ? FR : EN);

// ---------------------------------------------------------------------------------------------------------------
// Élicitation (mcp.user.elicitation.*) : message, titres de champs, enumNames ; valeurs d'enum en code (21 § 4.3)
// ---------------------------------------------------------------------------------------------------------------

export type ElicitationCatalog = {
  message: (schemaText: string) => string;
  decision: string;
  validate: string;
  modify: string;
  remark: string;
  accepted: string;
  modifyAsked: (remark: string) => string;
  declined: string;
};

const ELICIT_EN: ElicitationCatalog = {
  message: (schema) => `Validate this output schema?\n\n${schema}`,
  decision: 'Your answer',
  validate: 'Yes, validate',
  modify: 'Modify (add a remark)',
  remark: 'Remark',
  accepted: 'The user validated the schema; the trials are starting.',
  modifyAsked: (remark) => `The user asked for a change${remark === '' ? '' : ` (remark from the user, not from the site): ${remark}`}. Nothing was validated and no trial was started.`,
  declined: 'The user did not validate the schema. Nothing was validated and no trial was started; ask the user what to change, then call validate_schema.',
};

const ELICIT_FR: ElicitationCatalog = {
  message: (schema) => `Valider ce schéma de sortie ?\n\n${schema}`,
  decision: 'Ta réponse',
  validate: 'Oui, valider',
  modify: 'Modifier (ajouter une remarque)',
  remark: 'Remarque',
  accepted: 'L’utilisateur a validé le schéma ; les essais démarrent.',
  modifyAsked: (remark) => `L’utilisateur demande une modification${remark === '' ? '' : ` (remarque de l’utilisateur, pas du site) : ${remark}`}. Rien n’est validé et aucun essai n’est lancé.`,
  declined: 'L’utilisateur n’a pas validé le schéma. Rien n’est validé et aucun essai n’est lancé ; demande-lui quoi changer, puis appelle validate_schema.',
};

export const elicitationCatalog = (locale: McpLocale): ElicitationCatalog => (locale === 'fr' ? ELICIT_FR : ELICIT_EN);

// ---------------------------------------------------------------------------------------------------------------
// Prompts : titres et descriptions (personne, menu du client) ; les corps sont en anglais (modèle, prompts.ts)
// ---------------------------------------------------------------------------------------------------------------

export const PROMPT_NAMES = ['new_api', 'fix_api', 'first_steps', 'review_catalog'] as const;
export type PromptName = (typeof PROMPT_NAMES)[number];

export const PROMPT_MENU: Record<McpLocale, Record<PromptName, { title: string; description: string }>> = {
  en: {
    new_api: { title: 'sym:new-api', description: 'Turn a data request on a website into a reusable API.' },
    fix_api: { title: 'sym:fix-api', description: 'Understand why an API is not healthy and what to do about it.' },
    first_steps: { title: 'sym:first-steps', description: 'A guided first run: see SYM investigate a page and return clean data.' },
    review_catalog: { title: 'sym:review-catalog', description: 'Review the API catalog: statuses, costs, what needs attention.' },
  },
  fr: {
    new_api: { title: 'sym:new-api', description: 'Transformer une demande de données sur un site en API réutilisable.' },
    fix_api: { title: 'sym:fix-api', description: 'Comprendre pourquoi une API n’est pas saine et quoi faire.' },
    first_steps: { title: 'sym:first-steps', description: 'Un premier essai guidé : voir SYM enquêter sur une page et rendre des données propres.' },
    review_catalog: { title: 'sym:review-catalog', description: 'Passer le catalogue en revue : statuts, coûts, ce qui demande de l’attention.' },
  },
};

export const PROMPT_ARGS: Record<McpLocale, Record<string, string>> = {
  en: { description: 'The data you want, in plain words.', url: 'Start URL of the page (https://…).', slug: 'Slug of the API (see list_apis).' },
  fr: { description: 'Les données voulues, en mots simples.', url: 'URL de départ de la page (https://…).', slug: 'Slug de l’API (voir list_apis).' },
};

/** Dernière phrase d'un `prompts/get` (21 § 4.3) : la langue de la réponse à la personne. */
export const answerIn = (locale: McpLocale): string => (locale === 'fr' ? 'Answer the user in French.' : 'Answer the user in English.');

// ---------------------------------------------------------------------------------------------------------------
// Gabarits fermés `bloquee` et `action_requise` (06) : jamais de verbe de contournement, jamais un texte du site
// ---------------------------------------------------------------------------------------------------------------

/**
 * Causes de blocage (06 « Panneau Bloquée ») : le site décide, SYM s'arrête. D-91 : `robots_disallowed` n'est plus produit
 * (le robots.txt n'est plus lu automatiquement) ; une API restée bloquée pour cette raison reçoit le gabarit par défaut.
 */
export const BLOCKED_CAUSES = ['blocked_by_protection', 'forbidden'] as const;

/**
 * Causes d'action requise (06 « Action requise », 06 § 4.2) couvertes par un gabarit fermé. D-91 : `robots_unreachable`
 * n'est plus produit (gabarit par défaut pour une ligne ancienne). UX-04 et UX-11 : contact du robot et prix du modèle.
 */
export const ACTION_CAUSES = [
  'cost_anomaly',
  'stale',
  'unavailable',
  'reinvestigation_failed',
  'rate_limited',
  'payment_required',
  'auth_required',
  'cookie_expired',
  'session_device_bound',
  'challenge_in_tunnel',
  'secret_unreadable',
  'instance_contact_missing',
  'llm_price_missing',
  'account_limit',
  'session_owner_required',
  'llm_refused',
] as const;

type TemplateSet = { blocked: Record<(typeof BLOCKED_CAUSES)[number] | 'default', string>; action: Record<(typeof ACTION_CAUSES)[number] | 'default', string> };

const TEMPLATES: Record<McpLocale, TemplateSet> = {
  en: {
    blocked: {
      default:
        'This site refuses automated access, so SYM stops here without insisting. It is the site’s decision. What can be done instead: look for an official API, an export or a partnership; use another source; write to the site’s publisher to ask for access; investigate again later, if the site has changed.',
      blocked_by_protection:
        'This site refuses automated access, so SYM stops here without insisting. It is the site’s decision. What can be done instead: look for an official API, an export or a partnership; use another source; write to the site’s publisher to ask for access; investigate again later, if the site has changed.',
      forbidden:
        'The site refuses access to this address, and SYM stops there. The IP address does not change after a refusal. What can be done instead: check your access rights, contact the publisher, or look for an official API or an export.',
    },
    action: {
      default: 'An action is needed in the console before this API can run again.',
      cost_anomaly: 'A run cost many times the median. Check the costs in the console.',
      stale: 'The last clean run is old. Start a run to check the API.',
      unavailable: 'The site does not answer. This is not a breakage: try again later.',
      reinvestigation_failed: 'The new investigation found nothing conformant; the previous version is kept. See the trials in the console.',
      rate_limited: 'The site asks to slow down (429). The pace was reduced and the address is unchanged.',
      payment_required: 'The site asks for a payment. Open the publisher’s site to see the offer.',
      auth_required: 'The site asks for a login. Connect the site in the console, with the browser extension.',
      cookie_expired: 'The session of this site has expired. Connect the site again in the console.',
      session_device_bound: 'The session of this site is tied to the user’s device and cannot be copied to the server. Run it from the user’s browser.',
      challenge_in_tunnel: 'A verification appeared in the user’s browser and the run is paused. The user handles it, then resumes the run.',
      secret_unreadable: 'A stored key is unreadable. Enter it again in the console.',
      instance_contact_missing: 'The robot contact is not set: it is required before the first investigation. Set it in the console, Settings > Robot identity; nothing was fetched and nothing was spent.',
      llm_price_missing: 'The model price is not set: enter it in the console, Settings > AI models.',
      account_limit: 'The platform flagged a limit on the account. No retry is made. Read the platform’s message.',
      session_owner_required: 'This API uses its owner’s session. Ask the owner, or create your own API.',
      llm_refused: 'The model refused the request; there is no automatic fallback. See the trial in the console.',
    },
  },
  fr: {
    blocked: {
      default:
        'Ce site refuse l’accès automatisé : SYM s’arrête là, sans insister. C’est la décision du site. Ce qui peut se faire à la place : chercher une API officielle, un export ou un partenariat ; utiliser une autre source ; écrire à l’éditeur du site pour demander l’accès ; ré-enquêter plus tard, si le site a changé.',
      blocked_by_protection:
        'Ce site refuse l’accès automatisé : SYM s’arrête là, sans insister. C’est la décision du site. Ce qui peut se faire à la place : chercher une API officielle, un export ou un partenariat ; utiliser une autre source ; écrire à l’éditeur du site pour demander l’accès ; ré-enquêter plus tard, si le site a changé.',
      forbidden:
        'Le site refuse l’accès à cette adresse, et SYM s’arrête là. L’adresse IP ne change pas après un refus. Ce qui peut se faire à la place : vérifier tes droits d’accès, contacter l’éditeur, ou chercher une API officielle ou un export.',
    },
    action: {
      default: 'Une action est attendue dans la console avant que cette API puisse tourner de nouveau.',
      cost_anomaly: 'Un run a coûté plusieurs fois la médiane. Vérifie les coûts dans la console.',
      stale: 'Le dernier run propre est ancien. Lance un run pour vérifier l’API.',
      unavailable: 'Le site ne répond pas. Ce n’est pas une casse : réessaie plus tard.',
      reinvestigation_failed: 'La ré-enquête n’a rien trouvé de conforme ; l’ancienne version est gardée. Vois les essais dans la console.',
      rate_limited: 'Le site demande de ralentir (429). La cadence a été réduite, l’adresse est inchangée.',
      payment_required: 'Le site demande un paiement. Ouvre le site de l’éditeur pour voir l’offre.',
      auth_required: 'Le site demande une connexion. Connecte le site dans la console, avec l’extension du navigateur.',
      cookie_expired: 'La session de ce site a expiré. Connecte de nouveau le site dans la console.',
      session_device_bound: 'La session de ce site est liée à l’appareil de l’utilisateur et ne peut pas être copiée sur le serveur. Lance-la depuis son navigateur.',
      challenge_in_tunnel: 'Une vérification est apparue dans le navigateur de l’utilisateur et le run est en pause. Il s’en occupe, puis reprend le run.',
      secret_unreadable: 'Une clé enregistrée est illisible. Ressaisis-la dans la console.',
      instance_contact_missing: 'Le contact du robot n’est pas renseigné : il est requis avant la première enquête. Renseigne-le dans Réglages > Identité du robot ; rien n’a été envoyé ni dépensé.',
      llm_price_missing: 'Le prix du modèle n’est pas renseigné : renseigne-le dans Réglages > Modèles IA.',
      account_limit: 'La plateforme a signalé une limite sur le compte. Aucune relance. Lis le message de la plateforme.',
      session_owner_required: 'Cette API utilise la session de son propriétaire. Demande au propriétaire, ou crée ta propre API.',
      llm_refused: 'Le modèle a refusé la demande ; aucun repli automatique. Vois l’essai dans la console.',
    },
  },
};

/** Gabarit fermé d'un statut `bloquee` (cause connue, sinon le gabarit par défaut). */
export function blockedTemplate(locale: McpLocale, cause: string | null): string {
  const set = TEMPLATES[locale].blocked;
  return (BLOCKED_CAUSES as readonly string[]).includes(cause ?? '') ? set[cause as (typeof BLOCKED_CAUSES)[number]] : set.default;
}

/** Gabarit fermé d'un statut `action_requise` (cause connue, sinon le gabarit par défaut). */
export function actionTemplate(locale: McpLocale, cause: string | null): string {
  const set = TEMPLATES[locale].action;
  return (ACTION_CAUSES as readonly string[]).includes(cause ?? '') ? set[cause as (typeof ACTION_CAUSES)[number]] : set.default;
}

/** Tous les gabarits fermés, par langue : lus par `assert_blocked_message_templates`. */
export const CLOSED_TEMPLATES = TEMPLATES;
