// SPDX-License-Identifier: AGPL-3.0-only
// Contrôles de la landing hors CI de PR (22 § 2.9, 22b § 5) : fonctions pures, appelées par les scripts de scripts/vitrine/ et
// testées sans réseau ni navigateur.
// - evaluateProbes : verdict des quatre contrôles rejoués sur la préproduction avant le GO, puis chaque semaine sur la production ;
// - goBlockers : ce qui interdit encore la mise en ligne (preuves non livrées, champs juridiques à fournir, tâches liées) ;
// - checkExternalLinks : les liens externes répondent 200, hors exceptions documentées (réseau injecté) ;
// - parseStars : étoiles et dernière version, écrites au build (landing/stars.json).
import type { ClaimsRegistry } from './claims.ts';
import type { PageProbe } from './probe.ts';
import { HOST_INJECTIONS, TRACKER_DOMAINS } from './trackers.ts';

export type Check = { name: string; ok: boolean; details: string[] };

/** Les quatre contrôles joués avant le GO sur la préproduction et chaque semaine en production (22b § 5), plus le formulaire. */
export function evaluateProbes(probes: readonly PageProbe[]): Check[] {
  const offenders = (pick: (probe: PageProbe) => string[]): string[] => probes.flatMap((probe) => pick(probe).map((item) => `${probe.url} : ${item}`));
  const check = (name: string, details: string[]): Check => ({ name, ok: details.length === 0, details });
  return [
    check('assert_landing_no_cookie', offenders((p) => [...(p.documentCookie ? [`document.cookie = ${p.documentCookie}`] : []), ...p.contextCookies.map((c) => `cookie ${c}`), ...p.setCookieHeaders, ...p.storageWritesBeforeAction, ...p.storageAfterLoad.map((entry) => `stockage après chargement : ${entry}`)])),
    check('assert_landing_no_third_party_request', offenders((p) => p.thirdPartyRequests)),
    // Demandé pendant la visite, ou seulement référencé dans le HTML servi (chargement différé, ou bloqué par la CSP) : 22b § 2.
    check('assert_landing_no_third_party_tracker', offenders((p) => [...p.trackerRequests, ...[...TRACKER_DOMAINS, ...HOST_INJECTIONS].filter((needle) => p.html.includes(needle)).map((needle) => `référencé dans le HTML : ${needle}`)])),
    check('assert_landing_csp_strict', offenders((p) => [...p.cspViolations, ...p.consoleErrors, ...(p.cspMeta === null ? ['balise CSP absente'] : []), ...(p.cspMeta && /unsafe-inline|unsafe-eval|frame-ancestors/.test(p.cspMeta) ? [`politique trop large : ${p.cspMeta}`] : [])])),
    check('assert_landing_no_signup', offenders((p) => (p.formCount > 0 ? [`${p.formCount} formulaire(s) ou champ(s)`] : []))),
  ];
}

/** Résultat daté d'un contrôle : ce que la page `#preuves` cite et ce que l'action planifiée archive. */
export function probeReport(url: string, checks: readonly Check[], now: Date = new Date()): { date: string; url: string; ok: boolean; checks: Check[] } {
  return { date: now.toISOString(), url, ok: checks.every((c) => c.ok), checks: [...checks] };
}

export type GoInputs = {
  registry: ClaimsRegistry;
  /** Ids des entrées affichées sur la landing. */
  displayed: readonly string[];
  /** Contenu des pages juridiques (sources Markdown). */
  legalSources: readonly { file: string; text: string }[];
  /** Nom d'un test : est-il un vrai test (et non un `test.todo`) ? */
  isRealTest: (name: string) => boolean;
  /** Version publiée (landing/stars.json), `null` avant la première release. */
  version: string | null;
  /** Langue de référence des pages juridiques (`LEGAL_REFERENCE_LANGUAGE`), choix provisoire à confirmer. */
  legalReferenceLanguage?: string;
};

/** Bloquants du GO de mise en ligne (⚠️ GO) ; `manual` : vérifications humaines que le code ne peut pas faire. */
export function goBlockers(inputs: GoInputs): { blockers: string[]; manual: string[] } {
  const blockers: string[] = [];
  const manual: string[] = [];
  for (const id of inputs.displayed) {
    const claim = inputs.registry.claims.find((entry) => entry.id === id);
    if (!claim) {
      blockers.push(`allégation absente du registre : ${id}`);
      continue;
    }
    if (claim.status !== 'relu') blockers.push(`allégation « ${id} » affichée au statut « ${claim.status} »`);
    else if (claim.reviewer !== 'human') blockers.push(`allégation « ${id} » affichée mais pas encore relue par un humain (relecture : ${claim.reviewer ?? 'absente'}) ; passer reviewer à « human » après la relecture (22b § 6)`);
    for (const proof of claim.proof.filter((entry) => entry.startsWith('test:'))) {
      const name = proof.slice('test:'.length);
      if (!inputs.isRealTest(name)) blockers.push(`allégation « ${id} » : la preuve ${name} n'est pas encore un vrai test (test.todo ou absent)`);
    }
    if (claim.tasks && claim.tasks.length > 0) manual.push(`allégation « ${id} » : confirmer la livraison de ${claim.tasks.join(', ')} (le registre la relie à ces tâches)`);
  }
  // 22 § 2.4 : en V1 le replay est écrit à la main d'après le scénario de la démo sans clé ; sa génération depuis l'enregistrement est en V1.1.
  if (inputs.displayed.includes('demo.recorded')) manual.push('étiquette « Démo enregistrée » (demo.recorded) : le replay est écrit à la main d\'après le scénario de la démo sans clé (M2, cas D0, mode démo de 3.10) ; un humain relit chaque bulle et l\'étiquette contre ce scénario avant le GO (génération depuis l\'enregistrement : V1.1, assert_landing_demo_matches_recording)');
  for (const { file, text } of inputs.legalSources) {
    for (const match of text.matchAll(/\[(?:À compléter|To be completed)[^\]]*\]/g)) blockers.push(`${file} : champ à fournir « ${match[0]} »`);
  }
  if (inputs.version === null) blockers.push('aucune version publiée dans landing/stars.json : la commande clonerait la branche par défaut, non épinglée (22 § 2.3 : un tag X.Y.Z, jamais latest) ; publier la release, puis pages.yml relance landing:stars');
  else if (!isReleaseVersion(inputs.version)) blockers.push(`version « ${inputs.version} » de landing/stars.json : pas une version X.Y.Z`);
  manual.push(`langue de référence des pages juridiques : « ${inputs.legalReferenceLanguage ?? 'fr'} », choix provisoire de 4.11 (22 § 8 le laisse à décider avec l'avocat) ; à confirmer, puis 4.7 porte la même clause dans CLA.md et TRADEMARK.md`);
  manual.push('#preuves : « 0 requête tierce » renvoie vers les exécutions datées de landing-production.yml ; lancer ce contrôle sur l\'adresse publique dès la mise en ligne, pour que le lien cite un résultat daté de la production (22 § 2.9)');
  manual.push('origine Pages partagée : landing:pages-origin ne voit que les dépôts PUBLICS du propriétaire ; vérifier à la main (réglages de l\'organisation, ou jeton d\'organisation en lecture) qu\'aucun dépôt privé ou interne ne publie un site Pages sur https://<propriétaire>.github.io, que le \'self\' de la CSP autoriserait ; à défaut, passer à un domaine personnalisé dédié (22 § 2.9)');
  manual.push('pages de doc du même site : VitePress écrit vitepress-theme-appearance=auto dans le stockage local dès leur ouverture, et elles sont servies sans CSP (la recherche Pagefind charge du WebAssembly) ; la Confidentialité le dit, mais 22 § 2.11 veut un stockage « seulement après que tu l\'as fait » : arbitrage explicite de l\'avocat, ou thème de doc sans écriture initiale, avant le GO');
  manual.push('relecture humaine des deux langues, des allégations et des marques (22b § 6) ; relecture juridique de l\'accroche D-46 et des pages juridiques (22 § 4)');
  return { blockers, manual };
}

/**
 * Retire les commentaires (`// …`, `/* … *\/`) d'un fichier de test en gardant les chaînes intactes (une adresse `https://…` ou un
 * motif `**\/*.ts` dans une chaîne n'ouvre pas de commentaire) : une déclaration commentée n'est pas un test.
 */
function stripComments(text: string): string {
  let out = '';
  let mode: 'code' | '"' | "'" | '`' = 'code';
  /** Profondeur des accolades de chaque `${ … }` ouvert dans un gabarit. */
  const braces: number[] = [];
  for (let i = 0; i < text.length; ) {
    const c = text[i] ?? '';
    const d = text[i + 1] ?? '';
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        while (i < text.length && text[i] !== '\n') i += 1;
        continue;
      }
      if (c === '/' && d === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end === -1 ? text.length : end + 2;
        out += ' ';
        continue;
      }
      if (c === '"' || c === "'" || c === '`') mode = c;
      else if (c === '{' && braces.length > 0) braces[braces.length - 1] = (braces.at(-1) ?? 0) + 1;
      else if (c === '}' && braces.length > 0) {
        if (braces.at(-1) === 0) {
          braces.pop();
          mode = '`';
        } else braces[braces.length - 1] = (braces.at(-1) ?? 1) - 1;
      }
      out += c;
      i += 1;
      continue;
    }
    if (c === '\\') {
      out += c + d;
      i += 2;
      continue;
    }
    if (mode === '`' && c === '$' && d === '{') {
      braces.push(0);
      mode = 'code';
      out += '${';
      i += 2;
      continue;
    }
    // Fin de la chaîne ; une chaîne simple ou double ne passe jamais la ligne (reprise sur erreur).
    if (c === mode || (c === '\n' && mode !== '`')) mode = 'code';
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Un nom de test est « réel » s'il ouvre le titre d'un test ou d'un groupe qui s'exécute : `test("nom …")`, `it(…)`, `describe(…)`,
 * `test.describe(…)` (Playwright), avec au plus `.only`, `.concurrent`, `.sequential`, `.serial`, `.parallel` ou `.each(…)`. Sont
 * refusés : `test.todo`, `skip`, `skipIf`, `runIf`, `fails`, `fixme`, les alias `xit`, `xtest` et `xdescribe`, une mention en
 * commentaire. Et tant qu'un `test.todo("<nom>")` ou `test.todo("<nom> …")` reste ouvert dans le corpus (volet encore à livrer, même
 * règle que `stillTodo` de tests/docs-guards.unit.test.ts), le nom n'est pas livré.
 */
export function isRealTestIn(corpus: readonly { file: string; text: string }[], name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quote = `["'\\x60]`;
  const todo = new RegExp(`(?<![\\w.$])test\\.todo\\(\\s*${quote}${escaped}(?:${quote}|\\s)`);
  if (corpus.some(({ text }) => todo.test(stripComments(text)))) return false;
  const modifiers = `(?:\\.(?:only|concurrent|sequential|serial|parallel|describe)|\\.each\\([^)]*\\))*`;
  const declaration = new RegExp(`(?<![\\w.$])(?:test|it|describe)${modifiers}\\(\\s*${quote}${escaped}(?!\\w)`);
  return corpus.some(({ text }) => declaration.test(stripComments(text)));
}

export type LinkVerdict = { url: string; status: number | string };

/** Les liens externes répondent 200 (HEAD puis GET), hors exceptions documentées ; le réseau est injecté. */
export async function checkExternalLinks(urls: readonly string[], fetchStatus: (url: string, method: 'HEAD' | 'GET') => Promise<number>, exceptions: ReadonlySet<string> = new Set()): Promise<LinkVerdict[]> {
  const failures: LinkVerdict[] = [];
  for (const url of [...new Set(urls)].sort()) {
    if (exceptions.has(url) || exceptions.has(new URL(url).host)) continue;
    let status: number | string;
    try {
      status = await fetchStatus(url, 'HEAD');
      if (status >= 400) status = await fetchStatus(url, 'GET');
    } catch (error) {
      status = error instanceof Error ? error.message : String(error);
    }
    if (status !== 200) failures.push({ url, status });
  }
  return failures;
}

export type StarsFile = { stars: number; version: string | null; updatedAt: string | null };

/** Version publiable dans la commande à copier : `X.Y.Z` seulement (22 § 2.3 : un tag X.Y.Z ; jamais une pré-version), ancrée des deux côtés. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;
/** Tag de release lu dans l'API GitHub : la version, avec ou sans `v`, et rien d'autre (un nom de référence git admet `;`, `|`, `$`…). */
const RELEASE_TAG = /^v?\d+\.\d+\.\d+$/;

export const isReleaseVersion = (value: string): boolean => RELEASE_VERSION.test(value);

/** Étoiles et dernière version depuis les réponses de l'API GitHub ; la valeur précédente est gardée si une réponse est inexploitable. */
export function parseStars(previous: StarsFile, repository: unknown, release: unknown, now: Date = new Date()): StarsFile {
  const count = (repository as { stargazers_count?: unknown } | null)?.stargazers_count;
  const stars = typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : previous.stars;
  const tag = (release as { tag_name?: unknown } | null)?.tag_name;
  const version = typeof tag === 'string' && RELEASE_TAG.test(tag) ? tag.replace(/^v/, '') : previous.version;
  const changed = stars !== previous.stars || version !== previous.version;
  return { stars, version, updatedAt: changed ? now.toISOString() : previous.updatedAt };
}

/** Contenu de landing/stars.json, validé : `stars` entier ≥ 0, `version` `X.Y.Z` ou `null`, `updatedAt` texte ou `null` ; sinon le build échoue. */
export function parseStarsFile(raw: unknown): StarsFile {
  const fail = (why: string): never => {
    throw new Error(`landing/stars.json invalide : ${why}`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('objet attendu');
  const { stars, version, updatedAt } = raw as Record<string, unknown>;
  if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 0) return fail(`stars doit être un entier ≥ 0 (${JSON.stringify(stars)})`);
  if (version !== null && (typeof version !== 'string' || !isReleaseVersion(version))) return fail(`version doit être X.Y.Z ou null (${JSON.stringify(version)})`);
  if (updatedAt !== null && typeof updatedAt !== 'string') return fail('updatedAt doit être une date ISO ou null');
  return { stars, version, updatedAt };
}

/**
 * Premier octet du document, mesuré depuis le début de la navigation (`startTime`, 0 pour le document) : sous bridage réseau émulé
 * par le protocole DevTools, Chromium retient la requête AVANT `requestStart`, donc `responseStart - requestStart` ne voit pas la
 * latence émulée (1 ms sur la boucle locale) ; `responseStart - startTime` la contient (assert_landing_perf_budget).
 */
export function navigationTtfb(entry: { startTime: number; responseStart: number } | undefined): number {
  return entry ? entry.responseStart - entry.startTime : 0;
}

/**
 * Dépôts du même propriétaire qui publient AUSSI un site GitHub Pages (22 § 2.9) : sans domaine personnalisé, tous les sites Pages d'un
 * propriétaire partagent l'origine `https://<propriétaire>.github.io`, donc le `'self'` de la CSP de la landing autorise leurs scripts et
 * leurs feuilles. La mise en ligne exige qu'il n'y en ait aucun (pages.yml) et la sonde hebdomadaire le revérifie (landing-production.yml).
 */
export function sharedPagesOrigin(repos: readonly { full_name: string; has_pages?: boolean }[], self: string): string[] {
  return repos
    .filter((repo) => repo.has_pages === true && repo.full_name.toLowerCase() !== self.toLowerCase())
    .map((repo) => repo.full_name)
    .sort();
}

export type LighthouseCategories = Record<string, { score: number | null } | undefined>;

/** Catégories Lighthouse sous leur seuil (scores sur 100, budgets.json) ; une catégorie absente ou non notée échoue aussi. */
export function lighthouseFailures(categories: LighthouseCategories, thresholds: Readonly<Record<string, number>>): string[] {
  return Object.entries(thresholds).flatMap(([id, min]) => {
    const score = categories[id]?.score;
    if (typeof score !== 'number') return [`${id} : non noté`];
    const value = Math.round(score * 100);
    return value < min ? [`${id} : ${value} < ${min}`] : [];
  });
}
