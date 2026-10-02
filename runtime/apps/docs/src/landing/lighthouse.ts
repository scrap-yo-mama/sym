// SPDX-License-Identifier: AGPL-3.0-only
// Lighthouse mobile de la landing (22b § 1 « Lighthouse CI », 22b § 2 assert_landing_perf_budget, spike d'entrée de 4.11) : l'API Node
// de Lighthouse, configuration par défaut (mobile, réseau et processeur bridés en simulation), sur le Chromium de Playwright lancé avec
// un port de débogage éphémère de la boucle locale. Lecture seule d'une page déjà servie (préproduction), aucune connexion sortante.
import { createServer } from 'node:net';
import lighthouse from 'lighthouse';
import { chromium } from 'playwright-core';
import type { LighthouseCategories } from './checks.ts';

const LIGHTHOUSE_CATEGORIES = ['performance', 'accessibility', 'seo'] as const;

export type LighthouseRun = {
  url: string;
  categories: LighthouseCategories;
  formFactor: string;
  throttlingMethod: string;
  /** Audits notés sous 1 qui pèsent dans une catégorie : ce qu'il faut regarder quand un score baisse. */
  weakAudits: string[];
  runtimeError?: string;
};

/** Un port TCP libre de la boucle locale, choisi par le système. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Lance Lighthouse (mobile, configuration par défaut) sur chaque adresse, dans un seul Chromium. */
export async function runLighthouse(urls: readonly string[]): Promise<LighthouseRun[]> {
  const port = await freePort();
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'] });
  try {
    const runs: LighthouseRun[] = [];
    for (const url of urls) {
      const result = await lighthouse(url, { port, output: 'json', logLevel: 'error', onlyCategories: [...LIGHTHOUSE_CATEGORIES] });
      if (!result) throw new Error(`Lighthouse n'a rien rendu pour ${url}`);
      const { lhr } = result;
      const weakAudits = Object.values(lhr.categories).flatMap((category) =>
        category.auditRefs.flatMap((ref) => {
          const audit = lhr.audits[ref.id];
          return audit && ref.weight > 0 && typeof audit.score === 'number' && audit.score < 1 ? [`${category.id}/${ref.id} : ${audit.score}${audit.displayValue ? ` (${audit.displayValue})` : ''}`] : [];
        }),
      );
      runs.push({
        url,
        categories: Object.fromEntries(Object.entries(lhr.categories).map(([id, category]) => [id, { score: category.score }])),
        formFactor: lhr.configSettings.formFactor,
        throttlingMethod: lhr.configSettings.throttlingMethod,
        weakAudits,
        ...(lhr.runtimeError ? { runtimeError: `${lhr.runtimeError.code} : ${lhr.runtimeError.message}` } : {}),
      });
    }
    return runs;
  } finally {
    await browser.close();
  }
}
