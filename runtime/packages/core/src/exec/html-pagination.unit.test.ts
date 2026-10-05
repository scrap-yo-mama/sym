// SPDX-License-Identifier: AGPL-3.0-only
// Liste HTML paginée par le chemin (`/annonces/page/N/`, constat Janssens) : numéro de page dans le chemin
// (`param: url.path` + `path_pattern`), fin de liste sur une page 404 ou une page déjà vue (site qui ramène une page hors
// liste à la dernière ou à la première), hôte jamais modifié par la pagination (INV10).
import { describe, expect, it } from 'vitest';
import { validateDeclarativeSpec, type DeclarativeSpec } from '../dsl/spec.js';
import type { RenderedRequest } from '../dsl/template.js';
import { applyPathPattern, runDeclarative, type HttpExchange } from './index.js';

const HOST = 'zz_test_list.localhost';
const BASE = `http://${HOST}/nos-biens/`;
const SCHEMA = { type: 'object', required: ['title'], properties: { title: { type: 'string' } }, additionalProperties: false };
const signal = new AbortController().signal;

function htmlSpec(pagination: Record<string, unknown>): DeclarativeSpec {
  const raw = {
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: BASE, allowed_hosts: [HOST], params: [{ at: 'url.path', role: 'pagination' }] },
    sources: [{ id: 'page', from: 'html', records: 'article.item' }],
    fields: { title: { css: 'h3', type: 'string', required: true, ops: ['collapse_spaces', 'trim'] } },
    pagination,
  };
  const check = validateDeclarativeSpec(raw, { outputSchema: SCHEMA });
  if (!check.ok) throw new Error(JSON.stringify(check.errors));
  return check.spec;
}

const PATH_PAGINATION = { type: 'page_param', param: 'url.path', path_pattern: '/nos-biens/page/{page}/', start: 1, stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 200 } };

const page = (titles: readonly string[]): string => `<html><body>${titles.map((t) => `<article class="item"><h3> ${t} </h3></article>`).join('')}</body></html>`;
const ok = (url: string, body: string): HttpExchange => ({ status: 200, headers: { 'content-type': 'text/html' }, body, url });

describe('pagination par le chemin (param url.path, path_pattern)', () => {
  it('validation : motif obligatoire, un seul {page}, ni segment .., ni hôte ; page_param seulement', () => {
    expect(() => htmlSpec(PATH_PAGINATION)).not.toThrow();
    const bad = (p: Record<string, unknown>) => validateDeclarativeSpec({ ...htmlSpec(PATH_PAGINATION), pagination: { ...PATH_PAGINATION, ...p } }, { outputSchema: SCHEMA });
    expect(bad({ path_pattern: undefined }).ok).toBe(false);
    expect(bad({ path_pattern: '/a/{page}/{page}/' }).ok).toBe(false);
    expect(bad({ path_pattern: '/a/../{page}/' }).ok).toBe(false);
    expect(bad({ path_pattern: 'https://evil.test/{page}/' }).ok).toBe(false);
    expect(bad({ path_pattern: '//evil.test/{page}/' }).ok).toBe(true); // chemin `//…` : l'hôte reste celui de la requête (test suivant)
    expect(bad({ type: 'offset', step: 10 }).ok).toBe(false);
    const stray = validateDeclarativeSpec({ ...htmlSpec(PATH_PAGINATION), pagination: { type: 'page_param', param: 'url.path', path_pattern: '/x/{page}/', stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 5 } }, request: { method: 'GET', url: BASE, allowed_hosts: [HOST], params: [{ at: 'url.query.page', role: 'pagination' }] } }, { outputSchema: SCHEMA });
    expect(stray.ok).toBe(false);
  });

  it('page 1 = URL de la requête ; pages suivantes par le motif ; l’hôte ne change jamais (INV10)', () => {
    const request: RenderedRequest = { method: 'GET', url: `${BASE}?tri=prix`, headers: {} };
    expect(applyPathPattern(request, '/nos-biens/page/{page}/', 1, 1).url).toBe(`${BASE}?tri=prix`);
    expect(applyPathPattern(request, '/nos-biens/page/{page}/', 2, 1).url).toBe(`http://${HOST}/nos-biens/page/2/?tri=prix`);
    expect(new URL(applyPathPattern(request, '//evil.test/{page}/', 2, 1).url).hostname).toBe(HOST);
  });

  it('rejeu de toutes les pages jusqu’à la page vide ; « Nous consulter » et champs manquants n’arrêtent rien', async () => {
    const seen: string[] = [];
    const out = await runDeclarative({
      spec: htmlSpec(PATH_PAGINATION),
      input: {},
      outputSchema: SCHEMA,
      signal,
      transport: async (r) => {
        seen.push(new URL(r.url).pathname);
        const m = /\/page\/(\d+)\/$/.exec(new URL(r.url).pathname);
        const n = m === null ? 1 : Number(m[1]);
        return ok(r.url, n <= 3 ? page([`bien ${n}a`, `bien ${n}b`]) : page([]));
      },
    });
    expect(out).toMatchObject({ ok: true, pages: 4, stop: 'records_empty', truncated: false });
    expect(seen).toEqual(['/nos-biens/', '/nos-biens/page/2/', '/nos-biens/page/3/', '/nos-biens/page/4/']);
    if (out.ok) expect(out.records).toHaveLength(6);
  });

  it('page suivante en 404 : fin naturelle de la liste (`no_next`), pas une casse', async () => {
    const out = await runDeclarative({
      spec: htmlSpec(PATH_PAGINATION),
      input: {},
      outputSchema: SCHEMA,
      signal,
      transport: async (r) => (r.url.includes('/page/3/') ? { status: 404, headers: {}, body: 'not found', url: r.url } : ok(r.url, page([r.url.includes('/page/2/') ? 'b' : 'a']))),
    });
    expect(out).toMatchObject({ ok: true, pages: 2, stop: 'no_next' });
    if (out.ok) expect(out.records.map((x) => x['title'])).toEqual(['a', 'b']);
  });

  it('page 1 en 404 : toujours une casse `not_found`', async () => {
    const out = await runDeclarative({ spec: htmlSpec(PATH_PAGINATION), input: {}, outputSchema: SCHEMA, signal, transport: async (r) => ({ status: 404, headers: {}, body: '', url: r.url }) });
    expect(out).toMatchObject({ ok: false, failure: { failure_class: 'not_found' } });
  });

  it('page au-delà de la dernière ramenée à une page déjà vue : fin de la liste sans doublon', async () => {
    // Pages 1, 2, 3 distinctes ; la 4 (hors liste) renvoie la page 1 (redirection du site).
    const out = await runDeclarative({
      spec: htmlSpec(PATH_PAGINATION),
      input: {},
      outputSchema: SCHEMA,
      signal,
      transport: async (r) => {
        const m = /\/page\/(\d+)\/$/.exec(new URL(r.url).pathname);
        const n = m === null ? 1 : Number(m[1]);
        return ok(r.url, page([`bien ${n <= 3 ? n : 1}`]));
      },
    });
    expect(out).toMatchObject({ ok: true, pages: 4, stop: 'no_next' });
    if (out.ok) expect(out.records.map((x) => x['title'])).toEqual(['bien 1', 'bien 2', 'bien 3']);
  });
});

describe('banc réel : lien « suivant » sans rel=next, doublons entre pages (R02, R07)', () => {
  it('next_link : lien « next » dans li.next, relatif, suivi jusqu’à la page sans lien ; même hôte seulement', async () => {
    const seen: string[] = [];
    const pager = (n: number) => (n < 3 ? `<ul class="pager"><li class="current">Page ${n}</li><li class="next"><a href="page-${n + 1}.html">next</a></li></ul>` : '');
    const out = await runDeclarative({
      spec: htmlSpec({ type: 'next_link', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits: { hard_max_pages: 200 } }),
      input: {},
      outputSchema: SCHEMA,
      signal,
      transport: async (r) => {
        seen.push(new URL(r.url).pathname);
        const m = /page-(\d+)\.html$/.exec(r.url);
        const n = m === null ? 1 : Number(m[1]);
        return ok(r.url, page([`livre ${n}`]).replace('</body>', `${pager(n)}</body>`));
      },
    });
    expect(out).toMatchObject({ ok: true, pages: 3, stop: 'no_next' });
    expect(seen).toEqual(['/nos-biens/', '/nos-biens/page-2.html', '/nos-biens/page-3.html']);
    const evil = await runDeclarative({
      spec: htmlSpec({ type: 'next_link', stop: [{ when: 'records_empty' }, { when: 'repeated_cursor' }], limits: { hard_max_pages: 200 } }),
      input: {},
      outputSchema: SCHEMA,
      signal,
      transport: async (r) => ok(r.url, page(['a']).replace('</body>', '<a href="https://evil.zz_test.localhost/p2">Suivant ›</a></body>')),
    });
    expect(evil).toMatchObject({ ok: false });
  });

  it('?page=N : enregistrements déjà livrés écartés ; une page qui n’apporte que des doublons arrête la liste', async () => {
    const PARAM = { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 200 } };
    const raw = { ...htmlSpec(PATH_PAGINATION), request: { method: 'GET', url: BASE, allowed_hosts: [HOST], params: [{ at: 'url.query.page', role: 'pagination' }] }, pagination: PARAM };
    const check = validateDeclarativeSpec(raw, { outputSchema: SCHEMA });
    if (!check.ok) throw new Error(JSON.stringify(check.errors));
    const seen: number[] = [];
    // Pages 1 à 3 : biens distincts ; pages 4 et suivantes : les mêmes 3 programmes répétés (ordre changeant), jusqu'à 6.
    const out = await runDeclarative({
      spec: check.spec,
      input: {},
      outputSchema: SCHEMA,
      signal,
      transport: async (r) => {
        const n = Number(new URL(r.url).searchParams.get('page') ?? '1');
        seen.push(n);
        if (n <= 3) return ok(r.url, page([`bien ${n}a`, `bien ${n}b`]));
        if (n <= 6) return ok(r.url, page(n % 2 === 0 ? ['prog 1', 'prog 2', 'prog 3', 'prog 1'] : ['prog 3', 'prog 1', 'prog 2']));
        return ok(r.url, page([]));
      },
    });
    expect(out).toMatchObject({ ok: true, stop: 'no_next' });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    if (out.ok) expect(out.records.map((x) => x['title'])).toEqual(['bien 1a', 'bien 1b', 'bien 2a', 'bien 2b', 'bien 3a', 'bien 3b', 'prog 1', 'prog 2', 'prog 3']);
  });
});

describe('banc réel R02 (passage 2) : doublons entre pages sur une clé robuste, écart avec le compteur d’en-tête', () => {
  const SCHEMA_REF = { type: 'object', required: ['title'], properties: { title: { type: 'string' }, reference: { type: 'string' }, url: { type: 'string' }, surface: { type: 'number' } }, additionalProperties: false };
  const raw = (fields: Record<string, unknown>) => ({
    schema_version: 1,
    kind: 'declarative',
    request: { method: 'GET', url: BASE, allowed_hosts: [HOST], params: [{ at: 'url.query.page', role: 'pagination' }] },
    sources: [{ id: 'page', from: 'html', records: 'article.item' }],
    fields,
    pagination: { type: 'page_param', param: 'url.query.page', start: 1, stop: [{ when: 'records_empty' }], limits: { hard_max_pages: 200 } },
  });
  const specOf = (fields: Record<string, unknown>): DeclarativeSpec => {
    const check = validateDeclarativeSpec(raw(fields), { outputSchema: SCHEMA_REF });
    if (!check.ok) throw new Error(JSON.stringify(check.errors));
    return check.spec;
  };
  const FIELDS = {
    title: { css: 'h3', type: 'string', required: true, ops: ['collapse_spaces', 'trim'] },
    reference: { css: 'p.ref', type: 'string', ops: ['collapse_spaces', 'trim'] },
    url: { css: 'a', attr: 'href', type: 'string', ops: [{ op: 'abs_url', base: BASE }] },
  };
  const card = (title: string, ref: string, href: string) => `<article class="item"><h3>${title}</h3><p class="ref">${ref}</p><a href="${href}">voir</a></article>`;
  const header = (n: number) => `<h1>${n} annonces</h1>`;
  const html = (cards: string[], n = 359) => `<html><body>${header(n)}${cards.join('')}</body></html>`;

  /** Pages 1 à 3 : 3 biens distincts. Pages 4 à 7 : les 2 mêmes programmes neufs, référence de lot différente à chaque ligne. */
  const transport = (seen: number[]) => async (r: RenderedRequest): Promise<HttpExchange> => {
    const n = Number(new URL(r.url).searchParams.get('page') ?? '1');
    seen.push(n);
    if (n <= 3) return ok(r.url, html([card(`Bien ${n}a`, `R${n}a`, `/bien/${n}a`), card(`Bien ${n}b`, `R${n}b`, `/bien/${n}b`), card(`Bien ${n}c`, `R${n}c`, `/bien/${n}c?utm_source=x#top`)]));
    if (n <= 7) return ok(r.url, html(['A', 'B', 'A', 'B'].map((p, k) => card(`Programme ${p}`, `PROG ${p} LOT ${n * 10 + k}`, `https://neuf.${HOST}/prog/${p}/`))));
    return ok(r.url, html([]));
  };

  it('même URL de fiche, références différentes : une seule ligne par fiche ; la page qui ne répète que des fiches vues arrête la liste', async () => {
    const seen: number[] = [];
    const out = await runDeclarative({ spec: specOf(FIELDS), input: {}, outputSchema: SCHEMA_REF, signal, transport: transport(seen) });
    expect(out).toMatchObject({ ok: true, stop: 'no_next' });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    if (!out.ok) return;
    expect(out.records.map((r) => r['title'])).toEqual(['Bien 1a', 'Bien 1b', 'Bien 1c', 'Bien 2a', 'Bien 2b', 'Bien 2c', 'Bien 3a', 'Bien 3b', 'Bien 3c', 'Programme A', 'Programme B']);
    // Le doublon d'une même page (A, B, A, B) et des pages 5 : comptés et dits.
    expect(out.duplicates).toBe(2 + 4);
  });

  it('compteur d’en-tête (« 359 annonces ») différent du nombre livré : écart rendu dans le résultat', async () => {
    const out = await runDeclarative({ spec: specOf(FIELDS), input: {}, outputSchema: SCHEMA_REF, signal, transport: transport([]) });
    expect(out).toMatchObject({ ok: true, announced: 359 });
  });

  it('sans champ lien : empreinte des champs principaux (la référence, qui varie d’une ligne à l’autre, n’en fait pas partie)', async () => {
    const { url: _url, ...noUrl } = FIELDS;
    void _url;
    const seen: number[] = [];
    const out = await runDeclarative({ spec: specOf(noUrl), input: {}, outputSchema: SCHEMA_REF, signal, transport: transport(seen) });
    expect(out).toMatchObject({ ok: true, stop: 'no_next' });
    if (!out.ok) return;
    expect(out.records.map((r) => r['title'])).toEqual(['Bien 1a', 'Bien 1b', 'Bien 1c', 'Bien 2a', 'Bien 2b', 'Bien 2c', 'Bien 3a', 'Bien 3b', 'Bien 3c', 'Programme A', 'Programme B']);
  });

  it('un lien identique sur toutes les cartes (« # ») n’est pas une clé : aucune carte distincte n’est fusionnée', async () => {
    const out = await runDeclarative({
      spec: specOf(FIELDS),
      input: {},
      outputSchema: SCHEMA_REF,
      signal,
      transport: async (r) => {
        const n = Number(new URL(r.url).searchParams.get('page') ?? '1');
        return ok(r.url, n <= 2 ? html([card(`Bien ${n}a`, `R${n}a`, '/liste'), card(`Bien ${n}b`, `R${n}b`, '/liste'), card(`Bien ${n}c`, `R${n}c`, '/liste')]) : html([]));
      },
    });
    expect(out).toMatchObject({ ok: true });
    if (out.ok) expect(out.records).toHaveLength(6);
  });
});

describe('banc réel R01 (passage 2) : vérification de la pagination d’une longue liste sur un échantillon de pages', () => {
  const LAST = 53;
  /** 52 pages de 2 biens, la 53e d'un seul ; la page 54 répond 200 sans carte (comme Janssens). Pager réel : 1 2 3 … 52 53 ›. */
  const pager = (n: number): string => {
    const link = (p: number) => (p === n ? `<li class="current">${p}</li>` : `<li><a href="/nos-biens/page/${p}/">${p}</a></li>`);
    return `<ul class="pagination">${[1, 2, 3, LAST - 1, LAST].map(link).join('')}${n < LAST ? `<li><a rel="next" class="next" href="/nos-biens/page/${n + 1}/">›</a></li>` : ''}</ul>`;
  };
  const site = (seen: number[], last = LAST) => async (r: RenderedRequest): Promise<HttpExchange> => {
    const m = /\/page\/(\d+)\/$/.exec(new URL(r.url).pathname);
    const n = m === null ? 1 : Number(m[1]);
    seen.push(n);
    const body = n > last ? page([]) : page(n === last ? [`bien ${n}a`] : [`bien ${n}a`, `bien ${n}b`]);
    return ok(r.url, body.replace('</body>', `${pager(n).replaceAll(String(LAST), String(last))}</body>`));
  };

  it('échantillon : page 1, page 2, une page du milieu, la dernière annoncée et la suivante (5 pages au plus), règle d’arrêt constatée', async () => {
    const seen: number[] = [];
    const out = await runDeclarative({ spec: htmlSpec(PATH_PAGINATION), input: { max_pages: 200 }, outputSchema: SCHEMA, signal, samplePages: true, transport: site(seen) });
    expect(seen).toEqual([1, 2, 27, 53, 54]);
    expect(out).toMatchObject({ ok: true, stop: 'records_empty', pages: 5 });
  });

  it('liste dont la dernière page annoncée est déjà plus longue que le pager : la page suivante qui a des cartes n’est pas une fin constatée', async () => {
    const seen: number[] = [];
    // Le site annonce 53 pages mais en sert 70 : la page 54 a des cartes, le plafond d'échantillon est atteint.
    const out = await runDeclarative({ spec: htmlSpec(PATH_PAGINATION), input: { max_pages: 200 }, outputSchema: SCHEMA, signal, samplePages: true, transport: site(seen, 70) });
    expect(seen.length).toBeLessThanOrEqual(5);
    expect(out).toMatchObject({ ok: true });
  });

  it('liste courte (6 pages au plus) ou pager sans dernière page : lecture complète, comme avant', async () => {
    const seen: number[] = [];
    const out = await runDeclarative({ spec: htmlSpec(PATH_PAGINATION), input: { max_pages: 200 }, outputSchema: SCHEMA, signal, samplePages: true, transport: async (r) => {
      const m = /\/page\/(\d+)\/$/.exec(new URL(r.url).pathname);
      const n = m === null ? 1 : Number(m[1]);
      seen.push(n);
      return ok(r.url, page(n <= 4 ? [`bien ${n}`] : []));
    } });
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(out).toMatchObject({ ok: true, stop: 'records_empty' });
  });

  it('sans l’option, toutes les pages sont lues (le run n’échantillonne jamais)', async () => {
    const seen: number[] = [];
    const out = await runDeclarative({ spec: htmlSpec(PATH_PAGINATION), input: { max_pages: 200 }, outputSchema: SCHEMA, signal, transport: site(seen) });
    expect(seen).toHaveLength(54);
    expect(out).toMatchObject({ ok: true, stop: 'records_empty' });
  });
});
