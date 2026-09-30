// Gabarits de requête : `{{input.x}}`, `{{page.x}}`, `{{steps.id.nom}}`, rien d'autre (aucune expression). L'hôte de l'URL est statique
// (vérifié à l'enregistrement) et doit rester dans `allowed_hosts` après rendu (INV10 ; la garde SSRF de `net/` s'applique en plus).
import { DslError } from './errors.js';
import type { HttpRequestTemplate } from './spec.js';

export interface TemplateContext {
  input: Record<string, unknown>;
  page: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
}

export interface RenderedRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: { kind: 'json'; value: unknown } | { kind: 'form'; value: Record<string, string> } | { kind: 'text'; value: string };
}

const PLACEHOLDER = /\{\{\s*(input|page|steps)\.([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}\}/g;
const WHOLE = /^\s*\{\{\s*(input|page|steps)\.([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}\}\s*$/;
const MAX_RENDERED = 100_000;

const own = (o: unknown, key: string): unknown => (typeof o === 'object' && o !== null && Object.hasOwn(o, key) ? (o as Record<string, unknown>)[key] : undefined);

function lookup(ctx: TemplateContext, ns: string, a: string, b: string | undefined): unknown {
  const v = ns === 'steps' ? own(own(ctx.steps, a), b ?? '') : own(ns === 'input' ? ctx.input : ctx.page, a);
  if (v === undefined) throw new DslError('invalid_template', `gabarit ${ns}.${a}${b === undefined ? '' : `.${b}`} : valeur absente`);
  return v;
}

const scalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function renderString(text: string, ctx: TemplateContext, encode: boolean, keepType: boolean): unknown {
  const whole = keepType ? WHOLE.exec(text) : null;
  if (whole !== null) return lookup(ctx, whole[1] as string, whole[2] as string, whole[3]);
  const out = text.replace(PLACEHOLDER, (_m, ns: string, a: string, b: string | undefined) => {
    const v = lookup(ctx, ns, a, b);
    if (!scalar(v)) throw new DslError('invalid_template', `gabarit ${ns}.${a} : valeur scalaire attendue dans une chaîne`);
    return encode ? encodeURIComponent(String(v)) : String(v);
  });
  if (out.length > MAX_RENDERED) throw new DslError('value_too_large', 'requête rendue trop grande');
  return out;
}

function renderDeep(value: unknown, ctx: TemplateContext, depth = 0): unknown {
  if (depth > 32) throw new DslError('depth_exceeded', 'corps de requête trop profond');
  if (typeof value === 'string') return renderString(value, ctx, false, true);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, ctx, depth + 1));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) Object.defineProperty(out, k, { value: renderDeep(v, ctx, depth + 1), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return value;
}

/** Rend la requête ; refuse un hôte hors `allowedHosts`, un protocole autre que http(s), un en-tête à retour de ligne. */
export function renderRequest(template: HttpRequestTemplate, allowedHosts: readonly string[], ctx: TemplateContext): RenderedRequest {
  const url = renderString(template.url, ctx, true, false) as string;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DslError('invalid_template', 'URL rendue invalide');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new DslError('host_not_allowed', 'protocole refusé');
  if (parsed.username !== '' || parsed.password !== '' || !allowedHosts.includes(parsed.hostname)) {
    throw new DslError('host_not_allowed', "hôte de la requête absent de allowed_hosts");
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(template.headers ?? {})) {
    const rendered = String(renderString(value, ctx, false, false));
    if (/[\r\n]/.test(rendered)) throw new DslError('invalid_template', `en-tête « ${name} » : retour de ligne refusé`);
    headers[name] = rendered;
  }
  const out: RenderedRequest = { method: template.method, url: parsed.href, headers };
  if (template.body?.json !== undefined) out.body = { kind: 'json', value: renderDeep(template.body.json, ctx) };
  else if (template.body?.form !== undefined) out.body = { kind: 'form', value: renderDeep(template.body.form, ctx) as Record<string, string> };
  else if (template.body?.text !== undefined) out.body = { kind: 'text', value: String(renderString(template.body.text, ctx, false, false)) };
  return out;
}
