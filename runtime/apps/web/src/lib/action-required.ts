// SPDX-License-Identifier: AGPL-3.0-only
// Causes d'« Action requise » (06 § 2) : une tâche, pas une erreur. Titre, bouton principal et vérification en direct par
// cause ; même verbe dans le bandeau de la fiche et dans la colonne Statut du catalogue : les deux affichent le titre
// `actionRequired.<cause>.title` avec les mêmes paramètres (`actionTitleParams`). Aucune cause ne propose de
// relancer en boucle : une vérification affichée dans le navigateur de l'utilisateur ne reçoit jamais de réponse
// automatique (INV6), seule une nouvelle action de sa part relance une enquête (transition 17).

/** Destination du bouton principal : un écran de la console, la fiche elle-même (ancre) ou le site de l'éditeur. */
type ActionTarget = { kind: 'route'; to: string } | { kind: 'hash'; hash: string } | { kind: 'site' };

export type ActionCause = {
  /** Code de raison (06 § 4.2) qui porte la cause. */
  code: string;
  /** `actionRequired.<cause>.title|button|verify` dans les fichiers de langue. */
  cause: string;
  /** Bouton principal, ou null quand la cause n'a aucune action à proposer (compte limité, paiement sans site connu). */
  primary: ActionTarget | null;
  /** Vrai quand la console vérifie l'effet de l'action en direct (SSE ou bouton Tester). */
  verified: boolean;
};

const CAUSES: ActionCause[] = [
  { code: 'auth_required', cause: 'connect', primary: { kind: 'route', to: '/settings/extension' }, verified: true },
  { code: 'cookie_expired', cause: 'connect', primary: { kind: 'route', to: '/settings/extension' }, verified: true },
  { code: 'session_device_bound', cause: 'deviceBound', primary: { kind: 'route', to: '/settings/extension' }, verified: true },
  { code: 'proxy_not_configured', cause: 'proxy', primary: { kind: 'route', to: '/settings/proxies' }, verified: true },
  { code: 'instance_contact_missing', cause: 'instanceContact', primary: { kind: 'route', to: '/settings/robot' }, verified: true },
  { code: 'tunnel_offline', cause: 'tunnelOffline', primary: { kind: 'route', to: '/settings/extension' }, verified: true },
  { code: 'challenge_in_tunnel', cause: 'challenge', primary: { kind: 'hash', hash: '#launch' }, verified: false },
  { code: 'secret_unreadable', cause: 'secret', primary: { kind: 'route', to: '/settings/models' }, verified: true },
  { code: 'payment_required', cause: 'payment', primary: { kind: 'site' }, verified: false },
  { code: 'account_limit', cause: 'accountLimit', primary: null, verified: false },
];

/** Cause d'action requise portée par un code de raison, ou null si le code n'en est pas une. */
export function actionCause(code: string | null | undefined): ActionCause | null {
  return CAUSES.find((cause) => cause.code === code) ?? null;
}

export const ACTION_CAUSE_CODES: readonly string[] = CAUSES.map((cause) => cause.code);

/** Paramètres du titre d'une cause : ceux de la raison, le domaine de session de l'API à défaut, sinon `fallbackDomain`. */
export type ActionTitleParams = { domain: string; country: string; offer: string; platform: string };

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

export function actionTitleParams(params: Readonly<Record<string, unknown>> | null | undefined, sessionDomain: string | null | undefined, fallbackDomain: string): ActionTitleParams {
  return {
    domain: text(params?.domain) || sessionDomain || fallbackDomain,
    country: text(params?.country).toUpperCase(),
    offer: text(params?.offer),
    platform: text(params?.platform),
  };
}

/**
 * Site de l'éditeur (cause « paiement ») : un lien sortant vers le domaine concerné, jamais un appel du serveur. Nul quand le
 * domaine n'est pas un nom d'hôte simple (le bandeau et la ligne du catalogue n'ont alors aucun bouton vers le site).
 */
export function publisherSiteUrl(domain: string): string | null {
  return /^[a-z0-9.-]+$/i.test(domain) && domain.includes('.') ? `https://${domain}` : null;
}
