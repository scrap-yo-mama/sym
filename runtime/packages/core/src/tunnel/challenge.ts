// SPDX-License-Identifier: AGPL-3.0-only
// Détection d'un défi anti-bot ou d'une vérification dans le tunnel (07 §5, [_exclusions] X3). Module pur : l'extension
// l'applique à chaque page et à chaque réponse avant de rendre quoi que ce soit ; le worker l'applique aussi aux
// réponses reçues (défense en profondeur). Un défi détecté ARRÊTE tout : aucune commande de plus sur l'onglet, le run
// s'arrête (`challenge_in_tunnel`) et la main revient à l'humain. Rien ici ne cherche à résoudre ni à contourner un défi.

export type ChallengeProbe = {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly title?: string;
  /** Début du document (HTML) ou texte de l'arbre d'accessibilité. Seuls les premiers 200 000 caractères sont lus. */
  readonly text?: string;
};

/**
 * En-têtes posés par un éditeur de protection sur une page de défi seulement (documentés publiquement). Un en-tête
 * présent sur toutes les réponses d'un site protégé (`x-datadome: protected`…) n'en fait pas partie.
 */
const CHALLENGE_HEADERS: readonly (readonly [string, RegExp])[] = [['cf-mitigated', /challenge/i]];

/** Marqueurs de défi dans le document : widgets de vérification, pages interstitielles connues. */
const BODY_MARKERS: readonly RegExp[] = [
  /challenges\.cloudflare\.com/i,
  /\bcf[-_]chl[-_]/i,
  /\bcf-challenge\b/i,
  /\bchallenge-platform\b/i,
  /\bg-recaptcha\b/i,
  /recaptcha\/api\.js/i,
  /\bh-captcha\b/i,
  /hcaptcha\.com/i,
  /captcha-delivery\.com/i,
  /\bpx-captcha\b/i,
  /_Incapsula_Resource/i,
  /arkoselabs\.com|funcaptcha/i,
  /\bturnstile\b.*cloudflare|cloudflare.*\bturnstile\b/i,
];

/** Phrases d'une page de vérification (anglais, français). */
const PHRASES: readonly RegExp[] = [
  /verify (that )?you are (a )?human/i,
  /i am not a robot|i'm not a robot/i,
  /checking (if the site connection is secure|your browser)/i,
  /are you a robot\??/i,
  /complete the security check/i,
  /press (&amp;|&) hold/i,
  /vérifi(ez|er) que vous (êtes|etes) (un )?humain/i,
  /je ne suis pas un robot/i,
];

const TITLES: readonly RegExp[] = [/^\s*just a moment/i, /^\s*attention required/i, /^\s*security check\s*$/i, /^\s*un instant/i, /^\s*access to this page has been denied/i, /^\s*human verification/i];

const TEXT_LIMIT = 200_000;

/** Vrai si la page ou la réponse est un défi ou une vérification. */
export function detectChallenge(probe: ChallengeProbe): boolean {
  for (const [name, pattern] of CHALLENGE_HEADERS) {
    const value = probe.headers?.[name];
    if (value !== undefined && pattern.test(value)) return true;
  }
  if (probe.title !== undefined && TITLES.some((t) => t.test(probe.title!))) return true;
  const text = probe.text?.slice(0, TEXT_LIMIT);
  if (text !== undefined && text.length > 0) {
    if (BODY_MARKERS.some((m) => m.test(text))) return true;
    if (PHRASES.some((p) => p.test(text))) return true;
  }
  return false;
}

/** Titre d'un document HTML (premier `<title>`), sans évaluer quoi que ce soit. */
export function htmlTitle(html: string): string | undefined {
  const match = /<title[^>]*>([^<]{0,500})<\/title>/i.exec(html.slice(0, TEXT_LIMIT));
  return match?.[1]?.trim();
}
