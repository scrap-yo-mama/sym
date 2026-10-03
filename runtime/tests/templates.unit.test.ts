// SPDX-License-Identifier: AGPL-3.0-only
// `templates/` (tâche 3.12, 16 § 6) : modèles d'API validés par la CI. Chaque modèle est un export au format portable,
// scellé (empreinte juste), écrit à clés triées (fichier identique à sa mise en forme canonique), déclaratif (stratégie
// E1-E3 sans session ni tunnel), avec des fixtures synthétiques conformes au schéma de sortie (INV1), sans aucun champ de
// session, de cookie ni réglage de contournement, et sans mot de la liste d'exclusion. L'import sur une instance vierge
// est joué par apps/server/src/portability.integration.test.ts.
// « Tous passent leur fixture » (16 § 6) : chaque modèle a une réponse ENREGISTRÉE synthétique (`templates/responses/`),
// sur laquelle sa stratégie déclarative est rejouée hors ligne ; la sortie doit égaler `fixtures.items`, champ par champ.
import { readdirSync, readFileSync } from 'node:fs';
import { extractRecords, formatExport, parseApiExport, validateDeclarativeSpec, validateOutput } from '@runtime/core';
import { describe, expect, test } from 'vitest';

const DIR = new URL('../templates/', import.meta.url);
const RESPONSES = new URL('../templates/responses/', import.meta.url);
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

describe('templates/ (16 § 6)', () => {
  test('au moins deux modèles, nommés en kebab-case `.api.json`', () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) expect(f).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.api\.json$/);
  });

  test.each(files)('%s : export scellé et canonique, déclaratif, fixtures synthétiques conformes, aucun champ de session', (file) => {
    const text = readFileSync(new URL(file, DIR), 'utf8');
    const parsed = parseApiExport(JSON.parse(text), { runtimeVersion: '0.0.0' });
    if (!parsed.ok) throw new Error(`${file} : ${parsed.code} ${parsed.message}`);
    expect(parsed.ignored).toEqual([]);
    // Clés triées et mise en forme canonique : un diff git ne montre que les vrais changements.
    expect(text).toBe(formatExport(parsed.export));
    const doc = parsed.export;
    expect(doc.strategy).not.toBeNull();
    expect(['fetch', 'fetch_in_page', 'playwright']).toContain(doc.strategy!.execution);
    expect(doc.strategy!.network).toBe('direct');
    expect(doc.api.network_policy).toEqual({ allow: ['direct'] });
    // Fixtures synthétiques : présentes, conformes au schéma de sortie, aucune donnée de personne.
    expect(doc.fixtures?.items.length ?? 0).toBeGreaterThan(0);
    for (const item of doc.fixtures!.items) expect(validateOutput(doc.api.output_schema, item)).toEqual({ ok: true });
    expect(doc.api.contains_personal_data).toBe(false);
    expect(JSON.stringify(doc.api.output_schema)).not.toContain('x-personal');
    // Aucun planning actif ni cible d'alerte dans un modèle : le propriétaire les choisit après l'import.
    expect(doc.schedules.every((s) => !s.enabled)).toBe(true);
    expect(doc.api.alert_targets).toEqual([]);
    expect(text).not.toMatch(/"(?:cookies?|session\w*|secret\w*|password|token|proxy_ids|credentials?)"\s*:/i);
    expect(text).not.toMatch(/stealth|undetect|ind[ée]tectable|bypass|contourn|captcha|furtif|fingerprint/i);
  });

  test.each(files)('%s : la stratégie rejouée hors ligne sur sa réponse enregistrée donne exactement fixtures.items', (file) => {
    const parsed = parseApiExport(JSON.parse(readFileSync(new URL(file, DIR), 'utf8')), { runtimeVersion: '0.0.0' });
    if (!parsed.ok) throw new Error(`${file} : ${parsed.code} ${parsed.message}`);
    const doc = parsed.export;
    const base = file.replace(/\.api\.json$/, '');
    const recorded = readdirSync(RESPONSES).filter((f) => f.startsWith(`${base}.response.`));
    expect(recorded, `${file} : une réponse enregistrée attendue dans templates/responses/`).toHaveLength(1);
    const body = readFileSync(new URL(recorded[0]!, RESPONSES), 'utf8');
    // Réponse synthétique : aucune donnée réelle (préfixe Zz sur chaque enregistrement).
    expect(body).toMatch(/Zz/);
    const spec = validateDeclarativeSpec(doc.strategy!.spec, { outputSchema: doc.api.output_schema });
    if (!spec.ok) throw new Error(`${file} : stratégie invalide ${JSON.stringify(spec.errors)}`);
    const out = extractRecords(spec.spec, { body }, { outputSchema: doc.api.output_schema });
    expect(out.attempts.flatMap((a) => a.problems), file).toEqual([]);
    expect(out.ok, file).toBe(true);
    expect(out.records).toEqual(doc.fixtures!.items);
  });
});
