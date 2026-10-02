// SPDX-License-Identifier: AGPL-3.0-only
// Contrôles de la landing hors CI de PR (22 § 2.9, 22b § 5) : fonctions pures, appelées par les scripts de scripts/vitrine/ et
// testées sans réseau ni navigateur.
// - evaluateProbes : verdict des quatre contrôles rejoués sur la préproduction avant le GO, puis chaque semaine sur la production ;
// - goBlockers : ce qui interdit encore la mise en ligne (preuves non livrées, champs juridiques à fournir, tâches liées) ;
// - checkExternalLinks : les liens externes répondent 200, hors exceptions documentées (réseau injecté) ;
// - parseStars : étoiles et dernière version, écrites au build (landing/stars.json).
import type { ClaimsRegistry } from './claims.ts';
import type { PageProbe } from './probe.ts';

export type Check = { name: string; ok: boolean; details: string[] };

/** Les quatre contrôles joués avant le GO sur la préproduction et chaque semaine en production (22b § 5), plus le formulaire. */
export function evaluateProbes(probes: readonly PageProbe[]): Check[] {
  const offenders = (pick: (probe: PageProbe) => string[]): string[] => probes.flatMap((probe) => pick(probe).map((item) => `${probe.url} : ${item}`));
  const check = (name: string, details: string[]): Check => ({ name, ok: details.length === 0, details });
  return [
    check('assert_landing_no_cookie', offenders((p) => [...(p.documentCookie ? [`document.cookie = ${p.documentCookie}`] : []), ...p.contextCookies.map((c) => `cookie ${c}`), ...p.setCookieHeaders, ...p.storageWritesBeforeAction])),
    check('assert_landing_no_third_party_request', offenders((p) => p.thirdPartyRequests)),
    check('assert_landing_no_third_party_tracker', offenders((p) => p.trackerRequests)),
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
    for (const proof of claim.proof.filter((entry) => entry.startsWith('test:'))) {
      const name = proof.slice('test:'.length);
      if (!inputs.isRealTest(name)) blockers.push(`allégation « ${id} » : la preuve ${name} n'est pas encore un vrai test (test.todo ou absent)`);
    }
    if (claim.tasks && claim.tasks.length > 0) manual.push(`allégation « ${id} » : confirmer la livraison de ${claim.tasks.join(', ')} (le registre la relie à ces tâches)`);
  }
  for (const { file, text } of inputs.legalSources) {
    for (const match of text.matchAll(/\[(?:À compléter|To be completed)[^\]]*\]/g)) blockers.push(`${file} : champ à fournir « ${match[0]} »`);
  }
  if (inputs.version === null) manual.push('aucune version publiée dans landing/stars.json : la commande clone la branche par défaut (à régénérer après la première release)');
  manual.push('relecture humaine des deux langues, des allégations et des marques (22b § 6) ; relecture juridique de l\'accroche D-46 et des pages juridiques (22 § 4)');
  return { blockers, manual };
}

/** Un nom de test est « réel » s'il ouvre le titre d'un test ou d'un groupe (`test("nom …")`, `describe('nom …')`), et non un `test.todo` ni une simple mention. */
export function isRealTestIn(corpus: readonly { file: string; text: string }[], name: string): boolean {
  const declaration = new RegExp(`(?:test|it|describe)(?:\\.(?!todo\\b)\\w+)*\\(\\s*["'\\x60]${name}`);
  return corpus.some(({ text }) => declaration.test(text));
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

/** Étoiles et dernière version depuis les réponses de l'API GitHub ; la valeur précédente est gardée si une réponse est inexploitable. */
export function parseStars(previous: StarsFile, repository: unknown, release: unknown, now: Date = new Date()): StarsFile {
  const stars = typeof (repository as { stargazers_count?: unknown } | null)?.stargazers_count === 'number' ? (repository as { stargazers_count: number }).stargazers_count : previous.stars;
  const tag = (release as { tag_name?: unknown } | null)?.tag_name;
  const version = typeof tag === 'string' && /^v?\d+\.\d+\.\d+/.test(tag) ? tag.replace(/^v/, '') : previous.version;
  const changed = stars !== previous.stars || version !== previous.version;
  return { stars, version, updatedAt: changed ? now.toISOString() : previous.updatedAt };
}
