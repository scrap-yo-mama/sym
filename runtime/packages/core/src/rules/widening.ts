// SPDX-License-Identifier: AGPL-3.0-only
// Contrôle d'élargissement à l'enregistrement (tâche 2.10, 18 §4.7, 19 §4) : une LISTE FERMÉE de motifs repère une
// consigne qui vise une garde du code. Le fichier est enregistré, la réponse porte `widening_warnings[]` : « Cette consigne
// n'aura aucun effet : {garde} est fixé dans le code. » Le contrôle INFORME ; la protection, c'est le code (le plan d'essais
// est filtré par l'ensemble autorisé, `rule_widening_ignored`). Textes soumis à assert_ui_strings_no_forbidden_words.

export const WIDENING_GUARDS = ['robots', 'network_policy', 'protection', 'identity', 'session', 'tunnel', 'caps', 'step_checks', 'output_schema', 'isolation'] as const;
export type WideningGuard = (typeof WIDENING_GUARDS)[number];
export type WideningWarning = { readonly guard: WideningGuard; readonly message: string };

/** Nom de la garde dans le message (fr), sans mot interdit. */
const GUARD_LABELS: Readonly<Record<WideningGuard, string>> = {
  robots: 'le respect de robots.txt',
  network_policy: 'la politique réseau',
  protection: 'l’arrêt sur vérification anti-robot',
  identity: 'l’identité du moteur (User-Agent)',
  session: 'la session de l’utilisateur',
  tunnel: 'le choix du tunnel',
  caps: 'le plafond de coût et de durée',
  step_checks: 'le contrôle des étapes (post, V0 à V5, side_effect)',
  output_schema: 'le schéma de sortie',
  isolation: 'l’isolement entre utilisateurs',
};

/** Motifs (fr et en), sur le texte normalisé (minuscules, sans accents). Liste fermée, testée. */
const PATTERNS: Readonly<Record<WideningGuard, readonly RegExp[]>> = {
  robots: [/\bignor\w*\b[^.\n]{0,40}\brobots?\b/, /\brobots(?:\.txt)?\b[^.\n]{0,40}\b(?:ignor\w*|outrepass\w*|desactiv\w*|disable\w*|skip\w*)/, /\bdisallow\b[^.\n]{0,40}\b(?:ignor\w*|skip\w*)/, /\b(?:contourn\w*|bypass\w*|circumvent\w*)\b[^.\n]{0,40}\brobots?\b/, /\bne\s+(?:respect\w*|sui[st]|tien[st])\s+pas\b[^.\n]{0,30}\brobots?\b/, /\b(?:don'?t|do\s+not|never)\s+(?:respect|obey|follow|honou?r)\b[^.\n]{0,30}\brobots?\b/],
  network_policy: [/\b(?:proxy|proxies)\s+(?:residenti\w*)/, /\bresidential\s+prox/, /\bres_proxy\b/, /\b(?:change|chang\w+|rotat\w*|tourner)\b[^.\n]{0,30}\b(?:ip|adresses?\s+ip)\b/, /\bresidenti\w*\s+(?:ips?|adresses?)\b/, /\b(?:ips?|adresses?\s+ip)\s+residenti\w*/, /\b(?:exclu\w*|exclude\w*|evit\w*|avoid\w*|skip\w*)\s+(?:tous\s+les\s+|toutes\s+les\s+|all\s+)?(?:essais|attempts|couples|requetes|requests|acces)?\s*(?:en\s+)?direct\b/, /\b(?:jamais|never)\s+(?:en\s+)?direct\b/],
  protection: [/\bcaptcha/, /\bverification\s+anti-?robot/, /\b(?:resou\w*|resoud\w*|solve\w*|franchi\w*)\b[^.\n]{0,40}\b(?:defi|challenge|verification|captcha)/, /\banti-?bot\b/, /\bfingerprint/, /\bempreinte\s+(?:du\s+)?navigateur/, /\bcloudflare\b/, /\bturnstile\b/, /\b(?:contourn\w*|bypass\w*|circumvent\w*)\b[^.\n]{0,40}\b(?:protection|verification|checks?|challenges?|defis?|waf|blocages?|blocks?)\b/],
  identity: [/\buser[- ]?agents?\b/, /\b(?:copie|copy|spoof\w*|falsifi\w*|imit\w*)\b[^.\n]{0,40}\b(?:navigateur|browser)/],
  session: [/\b(?:change|chang\w+|altern\w*|rotat\w*|tourner)\b[^.\n]{0,30}\b(?:sessions?|comptes?|accounts?|cookies?)\b/, /\b(?:autres?|another|other)\s+(?:session|compte|account)/, /\bcookies?\b[^.\n]{0,40}\b(?:navigateur|browser)\b/, /\b(?:navigateur|browser)\b[^.\n]{0,40}\bcookies?\b/],
  tunnel: [/\btunnel\b/],
  caps: [/\b(?:max_cost_usd|budget_daily_usd|investigation_budget_usd|repair_budget_usd)\b/, /\b(?:augment\w*|depass\w*|ignor\w*|leve\w*|increase|raise|exceed)\b[^.\n]{0,40}\b(?:plafond|budget|cap|limit\w*|timeout|delai)/],
  step_checks: [/\bpost-?conditions?\b/, /\bside_effect\b/, /\bporte\s+v[0-5]\b/, /\bv[0-5]\b[^.\n]{0,20}\b(?:saute|skip|ignor\w*|desactiv\w*)/, /\b(?:saute|skip|ignor\w*)\b[^.\n]{0,20}\bv[0-5]\b/, /\bpost\b[^.\n]{0,30}\b(?:assoupli\w*|relax\w*|ignor\w*|retir\w*)/, /\b(?:assoupli\w*|relax\w*)\b[^.\n]{0,30}\bpost\b/],
  output_schema: [/\boutput_schema\b/, /\b(?:modifi\w*|chang\w*|assoupli\w*|relax\w*)\b[^.\n]{0,30}\bschema\s+de\s+sortie/],
  isolation: [/\b(?:api|regle|session|donnees?)s?\s+(?:d['’]un\s+)?autres?\s+utilisateurs?/, /\bother\s+users?\b/],
};

/** Texte comparé : minuscules, sans accents, apostrophes unifiées. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’`]/g, "'");
}

/** Avertissements d'élargissement d'un texte (règle, retour d'utilisateur) ; liste vide s'il ne vise aucune garde. */
export function wideningWarnings(text: string): WideningWarning[] {
  const folded = fold(text);
  const out: WideningWarning[] = [];
  for (const guard of WIDENING_GUARDS) {
    if (PATTERNS[guard].some((re) => re.test(folded))) out.push({ guard, message: `Cette consigne n’aura aucun effet : ${GUARD_LABELS[guard]} est fixé dans le code.` });
  }
  return out;
}
