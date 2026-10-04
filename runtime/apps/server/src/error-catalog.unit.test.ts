// SPDX-License-Identifier: AGPL-3.0-only
// Catalogue d'erreurs (U1.5, U6.2 ; 03-specs-mcp § 8 et § 10.3) : chaque code d'erreur REST ou MCP porte `message`,
// `action_label`, `what_to_do` et `retryable`, en fr et en ; l'enveloppe est la même sur REST (crochet `onSend`) et MCP.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultI18n, SPEC_REASON_CODES } from '@runtime/i18n';
import { describe, expect, test } from 'vitest';
import { errorTexts, hasErrorCode } from './error-catalog.js';
import { localizeErrors } from './i18n.js';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'generated' ? [] : sources(join(dir, e.name))) : e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) ? [join(dir, e.name)] : []));
}

/** Codes littéraux produits par le serveur : `sendError(reply, <statut>, '<code>', …)` et `error: { code: '<code>' … }`. */
function producedCodes(): Set<string> {
  const codes = new Set<string>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/sendError\(\s*[\w.]+,\s*\d+,\s*'([a-z][a-z_]+)'/g)) codes.add(m[1]!);
    if (/\/(routes|rest)\//.test(file) || file.endsWith('app.ts')) for (const m of text.matchAll(/error: \{ code: '([a-z][a-z_]+)'/g)) codes.add(m[1]!);
  }
  return codes;
}

const NEW_CODES = ['llm_model_missing', 'url_not_allowed', 'insufficient_scope', 'prerequisites_missing', 'llm_settings_unreadable', 'minimal_content', 'compile_values_mismatch', 'agent_engine_error'];

describe('assert_every_error_has_action (U1.5)', () => {
  test('chaque code produit par le serveur a message, action_label, what_to_do et retryable, en fr et en', () => {
    const codes = [...producedCodes(), ...NEW_CODES];
    expect(codes.length).toBeGreaterThan(80);
    for (const code of codes) {
      expect(hasErrorCode(code), `srv.error.${code}`).toBe(true);
      for (const locale of ['fr', 'en']) {
        const t = errorTexts(code, locale, { scope: 'apis:write', field: 'prix', n: 2, reason: 'constant', class: 'timeout' });
        expect(t.message, `${code} ${locale} message`).toMatch(/\S/);
        expect(t.action_label, `${code} ${locale} action`).toMatch(/\S/);
        expect(t.what_to_do, `${code} ${locale} what_to_do`).toMatch(/\S/);
        expect(typeof t.retryable).toBe('boolean');
        expect(t.what_to_do, code).not.toMatch(/[éèàêç]/);
      }
    }
  });

  test('le message d’une erreur en fr est tutoyé et sans code interne ; l’action est dite en verbe d’abord', () => {
    const fr = defaultI18n().renderer;
    for (const code of [...producedCodes(), ...NEW_CODES]) {
      const t = errorTexts(code, 'fr', { scope: 'apis:write', field: 'prix', n: 2, reason: 'constant', class: 'timeout' });
      expect(t.message, code).not.toMatch(/\b(vous|votre|vos)\b|\b\w+ez-(le|la|vous)\b/i);
      expect(t.message, code).not.toMatch(/\b[a-z]+_[a-z_]+\b(?<!dry_run)/);
    }
    expect(fr.render('srv.errorAction.insufficient_scope', { scope: 'apis:write' }, 'fr')).toBe('Crée une clé avec le droit apis:write dans Réglages > Clés d\'API');
  });

  test('un code inconnu garde une action et une marche à suivre non vides', () => {
    const t = errorTexts('zz_unknown_code', 'fr');
    expect(t.message).toBeNull();
    expect(t.action_label).toMatch(/\S/);
    expect(t.what_to_do).toMatch(/zz_unknown_code/);
  });
});

describe('assert_microcopy_inventory_complete (U6.2)', () => {
  const { catalogs } = defaultI18n();
  const flat = (locale: 'fr' | 'en') => {
    const out = new Map<string, string>();
    const walk = (tree: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(tree)) {
        if (typeof v === 'string') out.set(prefix + k, v);
        else walk(v as Record<string, unknown>, `${prefix}${k}.`);
      }
    };
    walk(catalogs[locale] as Record<string, unknown>, '');
    return out;
  };

  test('chaque code de raison a son message et son action en fr et en', () => {
    for (const locale of ['fr', 'en'] as const) {
      const keys = flat(locale);
      for (const code of SPEC_REASON_CODES) {
        expect(keys.get(`reasons.${code}`), `${locale} reasons.${code}`).toMatch(/\S/);
        expect(keys.get(`reasonNext.${code}`), `${locale} reasonNext.${code}`).toMatch(/\S/);
      }
    }
  });

  test('chaque état du bloc de résultat a son message et son action en fr et en', () => {
    for (const locale of ['fr', 'en'] as const) {
      const keys = flat(locale);
      for (const state of ['running', 'awaiting_decision', 'succeeded', 'failed', 'action_required', 'blocked']) {
        expect(keys.get(`srv.state.${state}`), `${locale} ${state}`).toMatch(/\S/);
        expect(keys.get(`srv.stateAction.${state}`), `${locale} ${state}`).toMatch(/\S/);
      }
    }
  });

  test('chaque cause de run publiée (run-error.ts) est au catalogue', () => {
    for (const code of ['instance_contact_missing', 'llm_price_missing', 'trial_cost_over_cap', 'no_conformant_strategy', 'investigation_budget_exhausted', 'investigation_timeout']) expect(hasErrorCode(code), code).toBe(true);
  });
});

describe('enveloppe REST (03 § 10.3) : crochet onSend', () => {
  const pool = { query: async () => ({ rows: [] }) } as never;
  const hook = localizeErrors({ pool, defaultLocaleEnv: 'en' });
  const run = async (error: Record<string, unknown>, opts: { status?: number; locale?: string } = {}) => {
    const headers: Record<string, unknown> = {};
    const reply = { statusCode: opts.status ?? 400, header: (k: string, v: unknown) => void (headers[k] = v) } as never;
    const request = { headers: opts.locale === undefined ? {} : { 'accept-language': opts.locale }, actor: null } as never;
    const out = await hook(request, reply, JSON.stringify({ error }));
    return { body: JSON.parse(out as string).error as Record<string, unknown>, headers };
  };

  test('un code connu reçoit message localisé, message_locale, action_label, what_to_do en anglais et retryable', async () => {
    const fr = await run({ code: 'insufficient_scope', message: 'scope apis:write requis pour cette clé d’API', scope_required: 'apis:write' }, { status: 403, locale: 'fr' });
    expect(fr.body).toMatchObject({
      code: 'insufficient_scope',
      message: 'Ta clé n\'a pas le droit apis:write.',
      message_locale: 'fr',
      action_label: 'Crée une clé avec le droit apis:write dans Réglages > Clés d\'API',
      scope_required: 'apis:write',
      retryable: false,
    });
    expect(fr.body['what_to_do']).toBe('Your key does not have the apis:write permission. Create a key with the apis:write permission in Settings > API keys.');
    const en = await run({ code: 'insufficient_scope', message: 'x', scope_required: 'apis:write' }, { status: 403, locale: 'en' });
    expect(en.body['message']).toBe('Your key does not have the apis:write permission.');
    expect(en.body['message_locale']).toBe('en');
  });

  test('un code sans entrée au catalogue garde son message d’origine et reçoit une action générique', async () => {
    const { body } = await run({ code: 'zz_unknown_code', message: 'texte d’origine' }, { locale: 'en' });
    expect(body['message']).toBe('texte d’origine');
    expect(body['message_locale']).toBe('fr');
    expect(body['action_label']).toMatch(/\S/);
    expect(body['what_to_do']).toMatch(/\S/);
    expect(typeof body['retryable']).toBe('boolean');
  });

  test('une cause écrite par la route (what_to_do, retryable, field) est conservée', async () => {
    const { body } = await run({ code: 'minimal_content', message: 'x', what_to_do: 'Custom guidance.', retryable: false, field: 'prix', details: { reason: 'constant' } }, { locale: 'fr' });
    expect(body['what_to_do']).toBe('Custom guidance.');
    expect(body['retryable']).toBe(false);
    expect(body['field']).toBe('prix');
    expect(body['message']).toBe('Le champ prix est constant ou vide : constant.');
  });

  test('un message qui porte le détail de la requête (entrée hors schéma, plafond…) reste celui de la route', async () => {
    const { body } = await run({ code: 'invalid_input', message: 'entrée hors input_schema : /q : requis' }, { locale: 'en' });
    expect(body['message']).toBe('entrée hors input_schema : /q : requis');
    expect(body['action_label']).toMatch(/\S/);
  });
});
