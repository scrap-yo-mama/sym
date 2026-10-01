// SPDX-License-Identifier: AGPL-3.0-only
// Preuves remises à un agent de réparation (tâche 1.7, revue ; 04 §5 : l'agent reçoit « les journaux masqués, le diff
// de forme et le schéma », jamais la page ; 17 §6, RGPD : minimisation). La garde de classification lit l'échange
// complet (corps borné) ; l'agent, lui, n'en reçoit que la FORME :
// - HTML : squelette des balises avec `id`, `class`, `role`, `type`, `name` et `itemprop` seulement (de quoi écrire un
//   sélecteur), sans texte, sans lien, sans `data-*`, sans script, style ni commentaire ;
// - JSON : clés et types, toutes les valeurs remplacées (`""`, `0`, `false`), un seul élément par tableau ;
// - autre corps : sa taille seulement ;
// - en-têtes réduits au type de contenu, URL sans requête ni fragment ;
// - texte libre (journal, instantané d'accessibilité) : secrets et données personnelles masqués.
// Tout ce qui reste (noms de classes, clés, chemin d'URL) passe par le registre de masquage du run (`ctx.personal`) et
// par les motifs d'e-mail et de téléphone. Les sujets effacés (`excludeSubjects`) ne sont connus que par empreinte : ils
// ne peuvent pas être masqués dans un texte, d'où la règle « aucune valeur de la page n'atteint l'agent ».
// Coût linéaire : même balayage que la détection (protection.ts), aucune expression à retour arrière sur le corps.
import { secretValues } from '../crypto/redact.js';
import { boundErrorDetail, maskPersonalText, type PersonalValueRegistry } from '../privacy/mask.js';
import type { AgentEvidence } from './guard.js';
import { endOfClosingTag } from './protection.js';
import type { HttpExchange } from './types.js';

/** Plafond d'une preuve minimisée (squelette ou texte), en caractères. */
const MINIMIZED_MAX_CHARS = 64 * 1024;
/** Attributs gardés dans le squelette HTML (sélecteurs). */
const KEPT_ATTRIBUTES = new Set(['id', 'class', 'role', 'type', 'name', 'itemprop']);
const MAX_ATTRIBUTE_VALUE = 200;
/** Partie d'une balise lue pour ses attributs. */
const MAX_TAG_READ = 512;
const MAX_TAG_CHARS = 2000;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_KEYS = 500;

const RAW_TEXT_OPEN = /(script|style|template|noscript)(?![\p{L}\p{N}_:-])/iuy;
const TAG_NAME = /^\/?\s*([a-zA-Z][a-zA-Z0-9:-]{0,40})/;
const ATTRIBUTE = /([^\s"'<>/=]{1,60})(?:\s*=\s*(?:"([^"]{0,2000})"|'([^']{0,2000})'|([^\s"'=<>`]{1,2000})))?/g;

const mask = (text: string, registry: PersonalValueRegistry | undefined): string => maskPersonalText(secretValues.redactText(text), registry);
const bound = (text: string): string => (text.length > MINIMIZED_MAX_CHARS ? text.slice(0, MINIMIZED_MAX_CHARS) : text);

/** Balise lue (`<name attrs>` ou `</name>`) réduite aux attributs gardés ; `''` pour un doctype, une instruction, etc. */
function skeletonTag(tag: string): string {
  const name = TAG_NAME.exec(tag);
  if (name === null || name[1] === undefined) return '';
  const tagName = name[1].toLowerCase();
  if (tag.trimStart().startsWith('/')) return `</${tagName}>`;
  const kept: string[] = [];
  const rest = tag.slice(name[0].length, MAX_TAG_READ);
  ATTRIBUTE.lastIndex = 0;
  for (let m = ATTRIBUTE.exec(rest), n = 0; m !== null && n < 40; m = ATTRIBUTE.exec(rest), n++) {
    const attr = (m[1] ?? '').toLowerCase();
    if (!KEPT_ATTRIBUTES.has(attr)) continue;
    const value = (m[2] ?? m[3] ?? m[4] ?? '').slice(0, MAX_ATTRIBUTE_VALUE).replace(/["<>]/g, '');
    kept.push(`${attr}="${value}"`);
  }
  return kept.length === 0 ? `<${tagName}>` : `<${tagName} ${kept.join(' ')}>`;
}

/** Squelette d'un document HTML : balises et attributs de sélection, chaque texte remplacé par `…`. */
function htmlSkeleton(html: string): string {
  const out: string[] = [];
  let size = 0;
  const push = (piece: string): void => {
    out.push(piece);
    size += piece.length;
  };
  const text = (segment: string): void => {
    if (/\S/.test(segment)) push('…');
  };
  let gt = -2;
  const nextGt = (from: number): number => {
    if (gt !== -1 && gt < from) gt = html.indexOf('>', from);
    return gt;
  };
  let i = 0;
  while (i < html.length && size <= MINIMIZED_MAX_CHARS) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      text(html.slice(i));
      break;
    }
    text(html.slice(i, lt));
    if (html.startsWith('!--', lt + 1)) {
      const end = html.indexOf('-->', lt + 4);
      if (end === -1) break;
      i = end + 3;
      continue;
    }
    RAW_TEXT_OPEN.lastIndex = lt + 1;
    const raw = RAW_TEXT_OPEN.exec(html);
    if (raw !== null) {
      const open = nextGt(lt + 1);
      if (open === -1) break;
      const close = endOfClosingTag(html, `</${(raw[1] ?? '').toLowerCase()}`, open + 1);
      if (close === -1) break;
      i = close;
      continue;
    }
    const end = nextGt(lt + 1);
    if (end === -1) {
      text(html.slice(lt));
      break;
    }
    if (end - lt - 1 > MAX_TAG_CHARS) {
      push('…');
      i = lt + 1;
      continue;
    }
    push(skeletonTag(html.slice(lt + 1, end)));
    i = end + 1;
  }
  return out.join('').replace(/…+/g, '…');
}

/** Forme d'une valeur JSON : clés (masquées) et types, valeurs remplacées, un élément par tableau. */
function jsonShape(value: unknown, registry: PersonalValueRegistry | undefined, depth = 0): unknown {
  if (depth > MAX_JSON_DEPTH) return null;
  if (typeof value === 'string') return '';
  if (typeof value === 'number') return 0;
  if (typeof value === 'boolean') return false;
  if (value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) return value.length === 0 ? [] : [jsonShape(value[0], registry, depth + 1)];
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, MAX_JSON_KEYS)
      .map(([key, v]) => [mask(key.slice(0, 200), registry), jsonShape(v, registry, depth + 1)]),
  );
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** URL sans requête ni fragment, chemin masqué. */
function minimalUrl(url: string, registry: PersonalValueRegistry | undefined): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${mask(decodePath(parsed.pathname).slice(0, 2048), registry)}`;
  } catch {
    return '';
  }
}

function minimalBody(exchange: HttpExchange, registry: PersonalValueRegistry | undefined): string {
  const body = exchange.body;
  if (body === '') return '';
  const type = (exchange.headers['content-type'] ?? '').toLowerCase();
  const head = body.trimStart().charAt(0);
  if (/json/.test(type) || ((type === '' || /text\/plain/.test(type)) && (head === '{' || head === '['))) {
    try {
      return bound(JSON.stringify(jsonShape(JSON.parse(body) as unknown, registry)));
    } catch {
      return `[JSON illisible : ${body.length} caractères]`;
    }
  }
  if (/html|xml/.test(type) || (type === '' && head === '<')) return bound(mask(htmlSkeleton(body), registry));
  return `[corps ${type === '' ? 'sans type' : type.split(';')[0]?.trim().slice(0, 100)} : ${body.length} caractères]`;
}

/**
 * Preuve minimisée pour un prompt de réparation : forme seulement, valeurs retirées, masquage par le registre du run.
 * À appliquer à chaque preuve APRÈS la garde de classification (qui lit, elle, l'échange complet).
 */
export function minimizeEvidence(evidence: AgentEvidence, registry?: PersonalValueRegistry): AgentEvidence {
  if (typeof evidence === 'string') return boundErrorDetail(evidence, registry, secretValues, MINIMIZED_MAX_CHARS) ?? '';
  const type = evidence.headers['content-type'];
  return {
    status: evidence.status,
    headers: type === undefined ? {} : { 'content-type': type.slice(0, 200) },
    body: minimalBody(evidence, registry),
    url: minimalUrl(evidence.url, registry),
  };
}
