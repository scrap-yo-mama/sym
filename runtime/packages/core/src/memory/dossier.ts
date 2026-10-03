// SPDX-License-Identifier: AGPL-3.0-only
// Dossier de mémoire du catalogue (tâche 2.12, 19 §2, r1 R9 à R16, r6 R2, R3, [r1 08]) : calculé par le CODE depuis les
// tables existantes (lues par `@runtime/db`, sous RLS), injecté dans le message `[user]` de l'enquête et de la réparation
// dans la section `<untrusted_catalog_memory>`. Aucun LLM n'écrit dans la mémoire ; jamais lue au rejeu E1-E3, jamais
// embarquée dans les prompts figés E4-E6.
// Règles (arbitrages n° 2 et 5) :
// - même propriétaire seulement (filtre ici en plus de la RLS : une API partagée avec l'instance reste hors du dossier) ;
// - valeurs d'items pour l'API en cours et le même domaine enregistrable seulement ; autres domaines : structure, profil
//   et `url_template` ; une API avec session ou en tunnel ne donne jamais de valeur, ni son endpoint (même en gabarit)
//   hors de son domaine ; agent instruit et réparation :
//   structurel (la réparation ne voit que des squelettes, tâche 2.3 : restriction, jamais un élargissement) ;
// - texte d'un retour pour l'API en cours seulement (300 caractères) ; ailleurs `kind` et `field` ;
// - refus : le fait et la date seulement, et ni stratégie, ni réseau, ni tunnel pour un domaine refusé (ni versions, ni
//   couples écartés, ni intentions d'étapes de l'API en cours, même lors d'une confirmation manuelle) ; les refus lus par
//   la requête dédiée (sans limite) s'ajoutent à ceux des entrées ;
// - version remplacée : `superseded_by`, jamais en tête ; entrée sans run sain depuis D jours : `stale` ;
// - masquage des couches 1 et 2 sur toute valeur et tout texte (x-personal toujours masqué, aucun réglage ne le démasque) ;
// - budget de tokens (≈ 4 caractères par token) : les entrées les moins bien classées tombent d'abord.
import { createHash } from 'node:crypto';
import type { Status } from '../status/types.js';
import { maskFeedbackForLlm, maskItemsForLlm } from '../privacy/llm-mask.js';
import { PersonalValueRegistry } from '../privacy/mask.js';
import type { FieldProfile } from '../quality/profile.js';
import { sanitizeUntrusted, safeFieldName } from './sanitize.js';
import { coupleOf, urlTemplate, type StrategySignature } from './signature.js';
import { structuralSimilarity } from './pqgram.js';
import type { Execution, Network } from '../model/index.js';
import type { PriorRefusal } from './refusal.js';

/** Valeurs de départ (r1 R9, 19b §6 : à valider). */
export const CATALOG_MEMORY_DEFAULTS = Object.freeze({
  maxSimilar: 3,
  sampleSize: 3,
  maxSampleSize: 5,
  sampleChars: 120,
  feedbackChars: 300,
  maxTokens: 1_500,
  staleDays: 30,
  /** Seuil du re-classement structurel pour l'étage 2 sans techno commune (r1 R11, à calibrer). */
  structuralThreshold: 0.5,
});

export type MemoryVersion = {
  readonly version: number;
  readonly execution: Execution;
  readonly network: Network;
  readonly current: boolean;
  readonly created_at: string;
  readonly superseded_by: number | null;
};

export type MemoryFeedback = { readonly kind: string; readonly field: string | null; readonly text: string; readonly at: string };

/** Une API du catalogue telle que la base la décrit (lue sous RLS par le propriétaire). */
export type MemoryEntry = {
  readonly api_id: string;
  readonly owner_id: string;
  readonly slug: string;
  /** Domaine enregistrable. */
  readonly domain: string;
  readonly status: Status;
  readonly status_reason: string | null;
  /** `requires_session` ou tunnel : données privées de l'utilisateur. */
  readonly session: boolean;
  readonly description: string;
  readonly observed_at: string;
  readonly last_healthy_at: string | null;
  readonly versions: readonly MemoryVersion[];
  readonly signature: StrategySignature | null;
  /** URL de la requête de la version courante (peut porter des valeurs : jamais montrée telle quelle hors domaine). */
  readonly endpoint: string | null;
  readonly pagination: string | null;
  readonly discarded: readonly { readonly couple: string; readonly reason: string }[];
  readonly feedback: readonly MemoryFeedback[];
  /** Intentions d'étapes E5 (indices non fiables). */
  readonly step_intents: readonly string[];
  readonly output_schema: unknown;
  readonly fields: Readonly<Record<string, FieldProfile>> | null;
  readonly sample: readonly unknown[];
  readonly refusal: { readonly class: 'forbidden' | 'bloquee'; readonly at: string } | null;
};

export type DossierMode = 'investigate' | 'repair' | 'instructed';

export type DossierRequest = {
  readonly ownerId: string;
  /** API en cours (étage 0) ; `null` : nouvelle API sans entrée. */
  readonly apiId: string | null;
  /** Domaine enregistrable de l'API en cours. */
  readonly domain: string;
  readonly signature?: StrategySignature | null;
  readonly description: string;
  readonly mode?: DossierMode;
  /** Refus du propriétaire lus par la requête dédiée (`readCatalogMemory`), y compris hors des entrées du dossier. */
  readonly refusals?: readonly PriorRefusal[];
  readonly now: Date;
  readonly sampleSize?: number;
  readonly maxTokens?: number;
};

export type DossierField = { readonly name: string; readonly type: string; readonly fill_rate?: number; readonly pattern?: string | null };
export type DossierVersion = { readonly version: number; readonly couple: string; readonly created_at: string; readonly superseded_by?: number };

export type SameApiSection = {
  readonly api_id: string;
  readonly status: Status;
  readonly reason: string | null;
  readonly observed_at: string;
  readonly stale: boolean;
  readonly versions: readonly DossierVersion[];
  readonly discarded: readonly { readonly couple: string; readonly reason: string }[];
  readonly feedback: readonly { readonly kind: string; readonly field: string | null; readonly text?: string }[];
  readonly step_intents: readonly string[];
  readonly fields: readonly DossierField[];
  readonly sample: readonly unknown[];
};

export type SimilarSection = {
  readonly api_id: string;
  readonly tier: 1 | 2 | 3;
  readonly domain: string;
  readonly status: Status;
  readonly observed_at: string;
  readonly stale: boolean;
  /** Couple de la version courante ; `null` si aucune version courante (une version remplacée n'est jamais en tête). */
  readonly couple: string | null;
  /** Même domaine : chemin de l'endpoint (gabarit) ; autre domaine : `url_template` seul. */
  readonly endpoint: string | null;
  readonly pagination: string | null;
  readonly tech: readonly string[];
  readonly feedback: readonly { readonly kind: string; readonly field: string | null }[];
  readonly fields: readonly DossierField[];
  readonly sample: readonly unknown[];
};

export type MemoryRef = { readonly ref_api_id: string; readonly ref_version: number | null; readonly tier: 0 | 1 | 2 | 3 };

export type CatalogDossier = {
  readonly same_api: SameApiSection | null;
  readonly similar: readonly SimilarSection[];
  readonly refusals: readonly { readonly domain: string; readonly at: string }[];
  readonly refs: readonly MemoryRef[];
  readonly text: string;
  readonly sha256: string;
  readonly tokens: number;
  readonly truncated: boolean;
};

const HEALTH: Readonly<Record<Status, number>> = { sain: 0, warning: 1, reparation: 2, enquete: 3, erreur: 4, action_requise: 5, bloquee: 6 };
const day = (iso: string): string => iso.slice(0, 10);
const tokensOf = (text: string): number => Math.ceil(text.length / 4);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Champs : profil (nom, type, remplissage, motif) ou, sans profil, nom et type du schéma ; jamais une valeur. */
function fieldsOf(entry: MemoryEntry): DossierField[] {
  const props = isRecord(entry.output_schema) && isRecord(entry.output_schema['properties']) ? entry.output_schema['properties'] : {};
  const out: DossierField[] = [];
  for (const [name, sub] of Object.entries(props)) {
    if (!safeFieldName(name)) continue;
    const p = entry.fields?.[name];
    const type = isRecord(sub) && typeof sub['type'] === 'string' ? sub['type'] : (p?.type ?? 'any');
    out.push(p === undefined ? { name, type } : { name, type, fill_rate: Math.round(p.fill_rate * 100) / 100, pattern: p.personal || p.suspected_personal ? null : (p.top_pattern === null ? null : sanitizeUntrusted(p.top_pattern, 20)) });
    if (out.length >= 40) break;
  }
  return out;
}

/** Couple de la version courante ; aucune version remplacée n'est présentée en tête. */
const currentVersion = (entry: MemoryEntry): MemoryVersion | undefined => entry.versions.find((v) => v.current && v.superseded_by === null);

function versionsOf(entry: MemoryEntry): DossierVersion[] {
  const sorted = [...entry.versions].sort((a, b) => Number(b.current) - Number(a.current) || b.version - a.version).slice(0, 5);
  return sorted.map((v) => ({ version: v.version, couple: coupleOf(v.execution, v.network), created_at: day(v.created_at), ...(v.superseded_by === null || v.current ? {} : { superseded_by: v.superseded_by }) }));
}

/** Valeurs bornées : chaînes nettoyées et tronquées, profondeur et clés limitées, noms de champs validés. */
function boundValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeUntrusted(value, CATALOG_MEMORY_DEFAULTS.sampleChars);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (depth > 3) return null;
  if (Array.isArray(value)) return value.slice(0, 5).map((v) => boundValue(v, depth + 1));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).filter(([k]) => safeFieldName(k)).slice(0, 40).map(([k, v]) => [k, boundValue(v, depth + 1)]));
  return null;
}

function stale(entry: MemoryEntry, now: Date): boolean {
  if (entry.last_healthy_at === null) return true;
  return now.getTime() - Date.parse(entry.last_healthy_at) > CATALOG_MEMORY_DEFAULTS.staleDays * 86_400_000;
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 4));

/** Étage d'une entrée (r1 R10) : 1 même domaine, 2 même plateforme ou forme de schéma (ou proche structurellement), 3 plein-texte. */
function tierOf(entry: MemoryEntry, req: DossierRequest): 1 | 2 | 3 | null {
  if (entry.domain === req.domain) return 1;
  const sig = entry.signature;
  const mine = req.signature ?? null;
  if (sig !== null && mine !== null) {
    if (sig.tech.length > 0 && sig.tech.some((t) => mine.tech.includes(t))) return 2;
    if (sig.schema_shape_sha256 === mine.schema_shape_sha256) return 2;
    if (structuralSimilarity(sig, mine) >= CATALOG_MEMORY_DEFAULTS.structuralThreshold) return 2;
  }
  const a = words(req.description);
  const b = words(entry.description);
  for (const w of a) if (b.has(w)) return 3;
  return null;
}

export function buildCatalogDossier(req: DossierRequest, entries: readonly MemoryEntry[]): CatalogDossier {
  const mode = req.mode ?? 'investigate';
  const sampleSize = Math.max(CATALOG_MEMORY_DEFAULTS.sampleSize, Math.min(CATALOG_MEMORY_DEFAULTS.maxSampleSize, req.sampleSize ?? CATALOG_MEMORY_DEFAULTS.sampleSize));
  const maxTokens = req.maxTokens ?? CATALOG_MEMORY_DEFAULTS.maxTokens;
  // Même propriétaire seulement (défense en profondeur, en plus de la RLS et du filtre SQL).
  const own = entries.filter((e) => e.owner_id === req.ownerId);
  const refusedDomains = new Map<string, string>();
  // Refus par domaine : le plus récent (le fait et la date seulement).
  const noteRefusal = (domain: string, at: string): void => {
    if (domain === '') return;
    if ((refusedDomains.get(domain) ?? '') < day(at)) refusedDomains.set(domain, day(at));
  };
  for (const e of own) if (e.refusal !== null) noteRefusal(e.domain, e.refusal.at);
  for (const r of req.refusals ?? []) noteRefusal(r.domain, r.at);
  const registry = new PersonalValueRegistry();
  // Réparation : structurel aussi (restriction de 2.12) — le prompt de réparation ne voit que des squelettes (2.3).
  const valuesAllowed = (e: MemoryEntry): boolean => mode === 'investigate' && !e.session && e.domain === req.domain && !refusedDomains.has(e.domain);
  const sampleOf = (e: MemoryEntry): unknown[] => (valuesAllowed(e) ? maskItemsForLlm(e.sample.slice(0, sampleSize), e.output_schema, registry).items.map((i) => boundValue(i)) : []);

  const self = req.apiId === null ? undefined : own.find((e) => e.api_id === req.apiId);
  const ranked = own
    .filter((e) => e.api_id !== req.apiId && !refusedDomains.has(e.domain))
    .map((e) => ({ e, tier: tierOf(e, req) }))
    .filter((x): x is { e: MemoryEntry; tier: 1 | 2 | 3 } => x.tier !== null)
    .sort((a, b) => a.tier - b.tier || HEALTH[a.e.status] - HEALTH[b.e.status] || Date.parse(b.e.observed_at) - Date.parse(a.e.observed_at) || a.e.api_id.localeCompare(b.e.api_id))
    .slice(0, CATALOG_MEMORY_DEFAULTS.maxSimilar);

  // Échantillons d'abord : leurs valeurs x-personal alimentent le registre qui masque ensuite les textes de retour.
  const selfSample = self === undefined ? [] : sampleOf(self);
  const similarSamples = ranked.map((x) => sampleOf(x.e));

  const selfRefused = self !== undefined && refusedDomains.has(self.domain);
  const same: SameApiSection | null =
    self === undefined
      ? null
      : {
          api_id: self.api_id,
          status: self.status,
          reason: self.status_reason,
          observed_at: self.observed_at,
          stale: stale(self, req.now),
          versions: selfRefused ? [] : versionsOf(self),
          // Domaine refusé : ni couple écarté (exécution et réseau), ni intention d'étape (19 §2).
          discarded: selfRefused ? [] : self.discarded.slice(0, 10).map((d) => ({ couple: sanitizeUntrusted(d.couple, 8), reason: sanitizeUntrusted(d.reason, 40) })),
          // Seul endroit où le texte d'un retour entre dans un dossier (300 caractères), masqué.
          feedback: self.feedback.slice(0, 5).map((f) => ({
            kind: sanitizeUntrusted(f.kind, 20),
            field: safeFieldName(f.field) ? f.field : null,
            text: sanitizeUntrusted(maskFeedbackForLlm(f.text, registry), CATALOG_MEMORY_DEFAULTS.feedbackChars),
          })),
          step_intents: mode === 'instructed' || selfRefused ? [] : self.step_intents.slice(0, 10).map((s) => sanitizeUntrusted(maskFeedbackForLlm(s, registry), CATALOG_MEMORY_DEFAULTS.sampleChars)),
          fields: fieldsOf(self),
          sample: selfSample,
        };

  const similar: SimilarSection[] = ranked.map(({ e, tier }, i) => {
    const cur = currentVersion(e);
    // API avec session ou en tunnel : jamais son endpoint (ni son gabarit) hors de son domaine.
    const hidden = e.session && e.domain !== req.domain;
    const endpoint = hidden ? null : e.endpoint === null ? (e.signature?.url_template ?? null) : urlTemplate(e.endpoint);
    return {
      api_id: e.api_id,
      tier,
      domain: e.domain,
      status: e.status,
      observed_at: e.observed_at,
      stale: stale(e, req.now),
      couple: cur === undefined ? null : coupleOf(cur.execution, cur.network),
      // Gabarit seulement (segments variables et valeurs de requête remplacés), même domaine compris.
      endpoint: endpoint === '' ? null : endpoint,
      pagination: e.pagination === null ? null : sanitizeUntrusted(e.pagination, 20),
      tech: (e.signature?.tech ?? []).slice(0, 5),
      // Retours d'une autre API : `kind` et `field` normalisés, jamais le texte (même domaine compris).
      feedback: e.feedback.slice(0, 5).map((f) => ({ kind: sanitizeUntrusted(f.kind, 20), field: safeFieldName(f.field) ? f.field : null })),
      fields: fieldsOf(e),
      sample: similarSamples[i] ?? [],
    };
  });
  // Refus du domaine en cours seulement : celui que l'enquête ou la réparation vise.
  const refusals = refusedDomains.has(req.domain) ? [{ domain: req.domain, at: refusedDomains.get(req.domain)! }] : [];

  // Budget : on retire d'abord les échantillons des entrées les moins bien classées, puis ces entrées.
  let kept = [...similar];
  let selfKept = same;
  let truncated = false;
  const render = () => renderBody(req.domain, selfKept, kept, refusals);
  while (tokensOf(render()) > maxTokens) {
    truncated = true;
    const last = kept.findLastIndex((s) => s.sample.length > 0);
    if (last >= 0) kept[last] = { ...kept[last]!, sample: kept[last]!.sample.slice(0, -1) };
    else if (kept.length > 0) kept = kept.slice(0, -1);
    else if (selfKept !== null && selfKept.sample.length > 0) selfKept = { ...selfKept, sample: selfKept.sample.slice(0, -1) };
    else if (selfKept !== null && selfKept.feedback.length > 0) selfKept = { ...selfKept, feedback: selfKept.feedback.slice(0, -1) };
    else break;
  }
  const text = render();
  const refs: MemoryRef[] = [
    ...(selfKept === null ? [] : [{ ref_api_id: selfKept.api_id, ref_version: currentVersion(self!)?.version ?? null, tier: 0 as const }]),
    ...kept.map((s) => ({ ref_api_id: s.api_id, ref_version: currentVersion(own.find((e) => e.api_id === s.api_id)!)?.version ?? null, tier: s.tier })),
  ];
  return { same_api: selfKept, similar: kept, refusals, refs, text, sha256: createHash('sha256').update(text).digest('hex'), tokens: tokensOf(text), truncated };
}

function renderBody(domain: string, same: SameApiSection | null, similar: readonly SimilarSection[], refusals: readonly { domain: string; at: string }[]): string {
  const lines: string[] = [];
  // Provenance en tête de chaque bloc (r6 R3).
  if (same !== null) lines.push(`[collecté sur ${domain} le ${day(same.observed_at)}] same_api ${JSON.stringify({ ...same, api_id: undefined })}`);
  for (const s of similar) lines.push(`[collecté sur ${s.domain} le ${day(s.observed_at)}] similar ${JSON.stringify({ ...s, api_id: undefined })}`);
  for (const r of refusals) lines.push(`[refus] ${JSON.stringify(r)}`);
  // Le contenu ne peut ni fermer l'enveloppe ni en imiter une autre.
  return lines.join('\n').replace(/untrusted_/gi, 'untrusted-');
}

/** Section `<untrusted_catalog_memory>` du message `[user]` ; chaîne vide si le dossier est vide. */
export function renderCatalogMemory(dossier: CatalogDossier): string {
  if (dossier.text === '') return '';
  return `<untrusted_catalog_memory>\n${dossier.text}\n</untrusted_catalog_memory>`;
}
