// SPDX-License-Identifier: AGPL-3.0-only
// Détection des refus d'accès par protection anti-robot (tâche 1.7, 04 §5 et §7, INV6, _exclusions X3).
// Ce module DÉTECTE pour ARRÊTER : il ne contient aucun mécanisme de résolution, ne modifie aucune requête et ne
// décide d'aucun changement de réseau. Une détection donne la classe `blocked_by_protection`, puis le statut `bloquee`.
//
// Trois sources de signal :
// 1. en-tête de défi (quel que soit le statut, y compris 200 et 202) : `cf-mitigated: challenge` (cité par 04 §5),
//    `x-amzn-waf-action: challenge|captcha` ;
// 2. signature d'un éditeur de protection sur un refus 403 (« 403 signé », 04 §7) : en-têtes propres à un éditeur ;
// 3. page de défi (interstitiel) reconnue par son contenu : titre, phrase de vérification, conteneur de widget de
//    vérification. Sur un refus (≥ 400), un signal suffit (titre ; phrase ou widget sur une page courte). Sur une
//    réponse 2xx (mode strict), il en faut deux, ou un seul sur une page quasi vide.
// Les tables sont « documentées par fixtures » (04 §5) : chaque ligne a sa fixture ou son test (échange enregistré dans
// classify.unit.test.ts pour les éditeurs réels). L'éditeur `x-zz-test-*` est la simulation générique et FICTIVE des
// fixtures (15 §8) ; aucun site réel n'envoie ces en-têtes.
// Les faux positifs coûtent cher (une API saine passerait `bloquee`) : sur une réponse 2xx, seul un signal fort compte
// (deux signaux, ou un seul sur une page quasi vide : un interstitiel n'a presque pas de texte visible).

export type ProtectionCode = 'challenge_header' | 'protection_signature' | 'challenge_page';
export type ProtectionSignal = { readonly code: ProtectionCode; readonly source: string };

type HeaderRule = { readonly header: string; readonly value?: RegExp; readonly source: string };

/** En-têtes de DÉFI : un défi est servi, quel que soit le code HTTP. */
const CHALLENGE_HEADERS: readonly HeaderRule[] = [
  { header: 'cf-mitigated', value: /^\s*challenge\b/i, source: 'cf-mitigated' },
  // AWS WAF : actions Challenge (202) et CAPTCHA (405), corps `challenge-container`.
  { header: 'x-amzn-waf-action', value: /^\s*(?:challenge|captcha)\b/i, source: 'x-amzn-waf-action' },
  { header: 'x-zz-test-shield', value: /^\s*challenge\b/i, source: 'zz-test-shield' },
];

/** Signatures d'ÉDITEUR : n'ont de sens que sur un refus 403 ; ailleurs (2xx, 404, 429, 5xx), le site les envoie aussi. */
const VENDOR_HEADERS: readonly HeaderRule[] = [
  { header: 'cf-mitigated', source: 'cf-mitigated' },
  { header: 'x-datadome', source: 'x-datadome' },
  { header: 'x-dd-b', source: 'x-dd-b' },
  { header: 'x-amzn-waf-action', source: 'x-amzn-waf-action' },
  { header: 'x-zz-test-shield', source: 'zz-test-shield' },
  { header: 'x-zz-test-shield-sig', source: 'zz-test-shield-sig' },
];

const matchHeader = (headers: Readonly<Record<string, string>>, rules: readonly HeaderRule[]): HeaderRule | undefined =>
  rules.find((rule) => {
    const value = headers[rule.header];
    return value !== undefined && (rule.value === undefined || rule.value.test(value));
  });

/** En-tête de défi (tout statut). Les noms d'en-têtes sont attendus en minuscules (contrat `HttpExchange`). */
export function protectionSignal(headers: Readonly<Record<string, string>>): ProtectionSignal | null {
  const rule = matchHeader(headers, CHALLENGE_HEADERS);
  return rule === undefined ? null : { code: 'challenge_header', source: rule.source };
}

/** Signature d'un éditeur de protection sur la réponse (à n'utiliser que pour un refus). */
export function vendorSignature(headers: Readonly<Record<string, string>>): ProtectionSignal | null {
  const rule = matchHeader(headers, VENDOR_HEADERS);
  return rule === undefined ? null : { code: 'protection_signature', source: rule.source };
}

/** Lecture bornée : un interstitiel est petit ; au-delà, seul le titre est lu (performances, faux positifs). */
const MAX_SCANNED_CHARS = 256 * 1024;
/** Texte visible au-delà duquel une phrase de vérification seule ne suffit plus (page de contenu, pas un interstitiel). */
const SHORT_PAGE_PHRASE = 4000;
/** Idem pour un conteneur de widget seul (un formulaire de contact peut en porter un). */
const SHORT_PAGE_WIDGET = 2000;
/**
 * Page quasi vide (texte visible) : en mode strict (réponse 2xx), un signal unique n'est retenu qu'en deçà. Un
 * interstitiel tient en quelques lignes ; une page de contenu, une FAQ ou un article, jamais.
 */
const NEAR_EMPTY_PAGE = 400;

/** Titres d'interstitiels de vérification (début du titre, en minuscules). */
const CHALLENGE_TITLE =
  /^(?:just a moment|attention required|security check|security verification|verifying you are (?:a )?human|human verification|bot verification|are you a robot|access to this page has been denied|pardon our interruption|checking your browser|one more step|vérification de sécurité|vérification humaine|êtes-vous un robot)(?![\p{L}\p{N}-])/u;

/** Phrases de vérification (texte visible, en minuscules, apostrophes normalisées). */
const CHALLENGE_PHRASES: readonly string[] = [
  'verify you are human',
  'verify that you are human',
  'verify you are a human',
  'verify you are not a robot',
  'confirm you are human',
  'confirm that you are human',
  'confirm you are not a robot',
  'i am not a robot',
  "i'm not a robot",
  'checking your browser before accessing',
  'checking if the site connection is secure',
  'enable javascript and cookies to continue',
  'press & hold to confirm',
  'press and hold to confirm',
  'unusual traffic from your computer network',
  'we believe you are using automation tools',
  'complete the security check to access',
  'vérifier que vous êtes humain',
  'vérifiez que vous êtes humain',
  'vérifions que vous êtes humain',
  'je ne suis pas un robot',
  "confirmer que vous n'êtes pas un robot",
  "vérifier que vous n'êtes pas un robot",
];

/** Conteneurs de widgets de vérification (attribut id, class ou name). */
const CHALLENGE_MARKUP =
  /\b(?:id|class|name)\s*=\s*["']?[^"'>]{0,200}?(?:challenge-form|challenge-platform|challenge-running|challenge-container|cf-challenge|px-captcha|captcha-container|captcha-delivery|g-recaptcha|h-captcha|cf-turnstile|zz-test-challenge)/i;

const normalize = (text: string): string => text.replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

function titleOf(html: string): string | undefined {
  const match = /<title\b[^>]{0,200}>([^<]{0,300})<\/title>/i.exec(html.slice(0, 64 * 1024));
  return match?.[1] === undefined ? undefined : normalize(decodeEntities(match[1]));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Texte visible approché : scripts, styles et balises retirés (le contenu de `<noscript>` reste visible). */
function visibleText(html: string): string {
  return normalize(
    decodeEntities(
      html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]{0,2000}>/g, ' '),
    ),
  );
}

const hasPhrase = (text: string): boolean => CHALLENGE_PHRASES.some((p) => text.includes(p));

const looksHtml = (body: string, headers: Readonly<Record<string, string>>): boolean => {
  const type = headers['content-type'];
  if (type !== undefined) return /html|xml/i.test(type);
  return body.trimStart().startsWith('<');
};

export type ChallengePageOptions = {
  /**
   * Mode strict, pour une réponse 2xx : deux signaux (titre, phrase, widget), ou un seul sur une page quasi vide. Sans
   * lui (refus ≥ 400, preuve à montrer à un agent), un titre d'interstitiel suffit.
   */
  readonly strict?: boolean;
};

/** Page de défi (interstitiel) reconnue par son contenu HTML. `null` pour une page de contenu ou un corps non HTML. */
export function detectChallengePage(body: string, headers: Readonly<Record<string, string>>, options: ChallengePageOptions = {}): ProtectionSignal | null {
  if (body === '' || !looksHtml(body, headers)) return null;
  const strict = options.strict === true;
  const title = titleOf(body);
  const titled = title !== undefined && CHALLENGE_TITLE.test(title);
  if (titled && !strict) return { code: 'challenge_page', source: 'title' };
  // Au-delà de la borne de lecture, seul le titre est lu : un très gros document n'est jamais une page quasi vide.
  if (body.length > MAX_SCANNED_CHARS) return null;
  const text = visibleText(body);
  const phrase = hasPhrase(text);
  const markup = CHALLENGE_MARKUP.test(body);
  if (strict) {
    const signals = Number(titled) + Number(phrase) + Number(markup);
    if (signals >= 2 || (signals === 1 && text.length <= NEAR_EMPTY_PAGE)) {
      return { code: 'challenge_page', source: titled ? 'title' : phrase ? 'phrase' : 'widget' };
    }
    return null;
  }
  if (phrase && (text.length <= SHORT_PAGE_PHRASE || markup)) return { code: 'challenge_page', source: 'phrase' };
  if (markup && text.length <= SHORT_PAGE_WIDGET) return { code: 'challenge_page', source: 'widget' };
  return null;
}

/**
 * Texte libre (instantané d'arbre d'accessibilité, extrait de journal, HTML) qui ressemble à une page de défi :
 * garde des prompts (aucune page de défi n'entre dans un prompt, 04b §6).
 */
export function challengeInText(text: string): boolean {
  if (text.trimStart().startsWith('<')) return detectChallengePage(text, {}) !== null;
  if (text.length > MAX_SCANNED_CHARS) return false;
  const normalized = normalize(text);
  return hasPhrase(normalized) && normalized.length <= SHORT_PAGE_PHRASE;
}
