// SPDX-License-Identifier: AGPL-3.0-only
// Surface du dépôt (22 §3.4) : licence, description et sujets, étiquettes, formulaires d'issues, index des vidéos, script VHS.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { githubDir, repoRoot, runtimeDir } from './paths.ts';
import type { Budgets } from './readme.ts';

/** `LICENSE` racine = texte AGPL-3.0 mot pour mot, identique à `LICENSES/AGPL-3.0-only.txt` (détection par GitHub). */
export function licenseProblems(root: string, copy: string): string[] {
  const problems: string[] = [];
  if (root !== copy) problems.push('LICENSE diffère de runtime/LICENSES/AGPL-3.0-only.txt');
  if (!root.startsWith('                    GNU AFFERO GENERAL PUBLIC LICENSE\n                       Version 3, 19 November 2007')) problems.push('LICENSE ne commence pas par le texte officiel de l\'AGPL-3.0');
  if (root.split('\n').length !== 662) problems.push(`LICENSE : ${root.split('\n').length} lignes (le texte officiel de l'AGPL-3.0 en compte 661, avec un saut de ligne final)`);
  if (!/<https:\/\/www\.gnu\.org\/licenses\/>\.\s*$/.test(root)) problems.push('LICENSE ne finit pas par la ligne officielle');
  return problems;
}

export const readLicenseFiles = (): { root: string; copy: string } => ({
  root: readFileSync(join(repoRoot, 'LICENSE'), 'utf8'),
  copy: readFileSync(join(runtimeDir, 'LICENSES/AGPL-3.0-only.txt'), 'utf8'),
});

export type RepoMetadata = {
  description: string;
  homepage?: string;
  topics: string[];
  discussions: boolean;
  privateVulnerabilityReporting: boolean;
  pinnedDiscussions?: string[];
  communityProfile?: string[];
};

const FORBIDDEN_TOPICS = ['captcha-solver', 'bypass', 'stealth', 'anti-detect', 'undetected'];
/** Noms de fournisseurs d'IA ou de concurrents : interdits comme sujets. */
const PROVIDER_TOPICS = /(openai|anthropic|claude|chatgpt|gemini|mistral|llama|deepseek|firecrawl|apify|scrapy|crawlee|puppeteer|selenium|browserbase)/;

export const readRepoMetadata = (): RepoMetadata => JSON.parse(readFileSync(join(githubDir, 'repo-metadata.json'), 'utf8')) as RepoMetadata;

/** `assert_repo_metadata`, version hors ligne : le fichier versionné que le GO applique au dépôt. */
export function repoMetadataProblems(meta: RepoMetadata, budgets: Budgets): string[] {
  const problems: string[] = [];
  const { descriptionMaxChars, topicsMin, topicsMax } = budgets.repo;
  if (meta.description.length > descriptionMaxChars || meta.description.length === 0) problems.push(`description : ${meta.description.length} caractères (1 à ${descriptionMaxChars})`);
  if (meta.topics.length < topicsMin || meta.topics.length > topicsMax) problems.push(`${meta.topics.length} sujets (${topicsMin} à ${topicsMax})`);
  for (const topic of meta.topics) {
    if (topic !== topic.toLowerCase() || !/^[a-z0-9][a-z0-9-]*$/.test(topic)) problems.push(`sujet « ${topic} » : minuscules, chiffres et traits d'union seulement`);
    if (FORBIDDEN_TOPICS.includes(topic) || PROVIDER_TOPICS.test(topic)) problems.push(`sujet interdit : ${topic}`);
  }
  if (new Set(meta.topics).size !== meta.topics.length) problems.push('sujets en double');
  if (!meta.homepage) problems.push('site web (homepage) non renseigné');
  if (!meta.discussions) problems.push('Discussions non activées');
  if (!meta.privateVulnerabilityReporting) problems.push('signalement privé des vulnérabilités non activé');
  return problems;
}

export type Label = { name: string; color: string; description: string };

/** Couleurs de la charte : jetons `--sym-*` de packages/ui (une seule source). */
export function charterColors(css = readFileSync(join(runtimeDir, 'packages/ui/src/theme.css'), 'utf8')): Set<string> {
  const colors = new Set<string>();
  for (const m of css.matchAll(/--sym-[a-z-]+:\s*#([0-9A-Fa-f]{6})\b/g)) colors.add((m[1] ?? '').toUpperCase());
  return colors;
}

export const readLabels = (): Label[] => parse(readFileSync(join(githubDir, 'labels.yml'), 'utf8')) as Label[];

export function labelProblems(labels: Label[], formLabels: readonly string[], colors: Set<string>): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  for (const label of labels) {
    if (names.has(label.name)) problems.push(`étiquette en double : ${label.name}`);
    names.add(label.name);
    if (!colors.has(label.color.toUpperCase())) problems.push(`étiquette « ${label.name} » : couleur ${label.color} hors de la charte`);
    if (!label.description || label.description.length > 100) problems.push(`étiquette « ${label.name} » : description de 1 à 100 caractères (limite de GitHub)`);
    if (label.name.length > 50) problems.push(`étiquette « ${label.name} » : plus de 50 caractères`);
  }
  for (const used of formLabels) if (!names.has(used)) problems.push(`les formulaires d'issues utilisent l'étiquette « ${used} », absente de labels.yml`);
  return problems;
}

type Form = { name: string; labels?: string[]; body: { type: string; id?: string; attributes?: { label?: string; options?: { label: string; required?: boolean }[] }; validations?: { required?: boolean } }[] };

export function readForms(): Record<string, Form> {
  const out: Record<string, Form> = {};
  for (const name of ['bug', 'feature', 'documentation']) out[name] = parse(readFileSync(join(githubDir, 'ISSUE_TEMPLATE', `${name}.yml`), 'utf8')) as Form;
  return out;
}

/** Formulaires bilingues (libellés « en · fr »), diagnostic obligatoire (bug), case « hors périmètre » obligatoire (22 §3.4). */
export function formProblems(forms: Record<string, Form>): string[] {
  const problems: string[] = [];
  const bilingual = (text: string | undefined): boolean => text !== undefined && /\S\s·\s\S/.test(text);
  for (const [file, form] of Object.entries(forms)) {
    if (!bilingual(form.name)) problems.push(`${file}.yml : nom non bilingue (« en · fr »)`);
    for (const item of form.body) {
      const label = item.attributes?.label;
      if (item.type !== 'markdown' && !bilingual(label)) problems.push(`${file}.yml : libellé « ${label} » non bilingue`);
      for (const option of item.attributes?.options ?? []) if (!bilingual(option.label)) problems.push(`${file}.yml : option « ${option.label.slice(0, 40)}… » non bilingue`);
    }
    const scope = form.body.find((item) => item.id === 'perimetre');
    if (!scope?.attributes?.options?.some((o) => o.required === true && /Hors périmètre|Out of scope/i.test(o.label))) problems.push(`${file}.yml : case « hors périmètre » obligatoire absente`);
  }
  const diagnostic = forms['bug']?.body.find((item) => item.id === 'diagnostic');
  if (!diagnostic?.validations?.required || !/Diagnostic \(obligatoire\)/.test(diagnostic.attributes?.label ?? '')) problems.push('bug.yml : diagnostic obligatoire absent');
  return problems;
}

/** `assert_media_index_current` : à chaque MINOR (X.Y.0 avec X ou Y non nul), MEDIA.md cite la version et une URL `user-attachments`. */
export function mediaProblems(version: string, media: string): string[] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return [`version illisible : ${version}`];
  const [, major, minor, patch] = match.map(Number) as [number, number, number, number];
  const isMinor = patch === 0 && (major > 0 || minor > 0);
  if (!isMinor) return [];
  const problems: string[] = [];
  if (!media.includes(version)) problems.push(`MEDIA.md ne cite pas la version ${version}`);
  if (!/https:\/\/github\.com\/user-attachments\/\S+/.test(media)) problems.push('MEDIA.md ne cite aucune URL github.com/user-attachments');
  return problems;
}

/** Script VHS : rejouable, sans site réel, sans clé, sans chemin personnel ; seules les commandes du quickstart sont tapées. */
export function tapeProblems(tape: string): string[] {
  const problems: string[] = [];
  if (!/^Output\s+\.github\/assets\/demo\/[a-z0-9-]+\.gif$/m.test(tape)) problems.push('Output : un GIF de .github/assets/demo/');
  for (const key of ['Width', 'Height', 'FontSize', 'TypingSpeed']) if (!new RegExp(`^Set ${key}\\b`, 'm').test(tape)) problems.push(`Set ${key} manquant (rendu reproductible)`);
  const allowed = new Set(['cd runtime', 'clear', 'docker compose up --build', '# Recorded demo: no real site, no key']);
  for (const m of tape.matchAll(/^Type\s+"(.*)"$/gm)) if (!allowed.has(m[1] ?? '')) problems.push(`commande tapée hors liste : « ${m[1]} »`);
  for (const url of tape.matchAll(/https?:\/\/[^\s"]+/g)) if (!/^https?:\/\/(localhost|127\.0\.0\.1)\b/.test(url[0])) problems.push(`URL hors de l'instance de démonstration : ${url[0]}`);
  if (/\/Users\/|\/home\/|sk-[A-Za-z0-9]{8,}|Bearer\s/.test(tape)) problems.push('chemin personnel ou clé dans le script');
  return problems;
}
