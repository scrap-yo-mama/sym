// SPDX-License-Identifier: AGPL-3.0-only
// robots.txt, RFC 9309 (tâche 1.11) : groupes, jeton produit puis `*`, règle la plus longue, `Allow` à égalité, `*` et
// `$`, encodage pourcent, `/robots.txt` toujours permis, `Crawl-delay`, signaux, motifs hostiles.
import { describe, expect, it } from 'vitest';
import { matchRules, normalizeOctets, parseRobots, robotsAllows, selectGroup } from './robots.js';

const allows = (text: string, url: string, token?: string) => robotsAllows(parseRobots(text), new URL(url, 'https://zz-test.example'), token).allowed;

describe('robots.txt (RFC 9309) : analyse et correspondance', () => {
  it('Disallow et Allow : la règle la plus longue l’emporte', () => {
    const txt = 'User-agent: *\nDisallow: /prive/\nAllow: /prive/ouvert\n';
    expect(allows(txt, '/prive/x')).toBe(false);
    expect(allows(txt, '/prive/')).toBe(false);
    expect(allows(txt, '/prive/ouvert/page')).toBe(true);
    expect(allows(txt, '/prive')).toBe(true);
    expect(allows(txt, '/public')).toBe(true);
  });

  it('égalité de longueur : Allow (le moins restrictif)', () => {
    expect(allows('User-agent: *\nDisallow: /page\nAllow: /page\n', '/page')).toBe(true);
  });

  it('Disallow vide : aucune règle ; fichier vide ou sans groupe : tout est permis', () => {
    expect(allows('User-agent: *\nDisallow:\n', '/x')).toBe(true);
    expect(allows('', '/x')).toBe(true);
    expect(allows('Disallow: /\n', '/x')).toBe(true);
  });

  it('groupe du jeton produit (casse ignorée, version ignorée) prioritaire sur `*`', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: scrapyomama/2.0\nAllow: /\nDisallow: /admin\n';
    expect(allows(txt, '/page')).toBe(true);
    expect(allows(txt, '/admin/x')).toBe(false);
    expect(allows(txt, '/page', 'OtherBot')).toBe(false);
    expect(selectGroup(parseRobots(txt)).matched).toBe('token');
  });

  it('blocage du robot par son jeton (page « Le robot Scrapyomama »)', () => {
    expect(allows('User-agent: Scrapyomama\nDisallow: /\n', '/')).toBe(false);
    expect(allows('User-agent: Scrapyomama\nDisallow: /\n', '/robots.txt')).toBe(true);
  });

  it('plusieurs user-agent pour un groupe ; groupes du même jeton fusionnés', () => {
    const txt = 'User-agent: a\nUser-agent: Scrapyomama\nDisallow: /one\n\nUser-agent: scrapyomama\nDisallow: /two\n';
    expect(allows(txt, '/one')).toBe(false);
    expect(allows(txt, '/two')).toBe(false);
    expect(allows(txt, '/three')).toBe(true);
  });

  it('une ligne user-agent après une règle ouvre un nouveau groupe', () => {
    const txt = 'User-agent: other\nDisallow: /\nUser-agent: *\nDisallow: /x\n';
    expect(allows(txt, '/y')).toBe(true);
    expect(allows(txt, '/x')).toBe(false);
  });

  it('jokers `*` et ancre `$`', () => {
    const txt = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /a*/c\nAllow: /a*/c/ok\n';
    expect(allows(txt, '/docs/x.pdf')).toBe(false);
    expect(allows(txt, '/docs/x.pdf?dl=1')).toBe(true);
    expect(allows(txt, '/abc/c/d')).toBe(false);
    expect(allows(txt, '/a/b/c')).toBe(false);
    expect(allows(txt, '/ab/c/ok/1')).toBe(true);
  });

  it('la requête fait partie du chemin comparé', () => {
    expect(allows('User-agent: *\nDisallow: /search?q=\n', '/search?q=x')).toBe(false);
    expect(allows('User-agent: *\nDisallow: /search?q=\n', '/search')).toBe(true);
  });

  it('encodage pourcent normalisé des deux côtés (non réservés décodés, UTF-8 encodé)', () => {
    expect(normalizeOctets('/%7euser/%2fa')).toBe('/~user/%2Fa');
    expect(normalizeOctets('/café')).toBe('/caf%C3%A9');
    expect(allows('User-agent: *\nDisallow: /café\n', '/caf%C3%A9/menu')).toBe(false);
    expect(allows('User-agent: *\nDisallow: /%7Euser\n', '/~user/x')).toBe(false);
  });

  it('commentaires, BOM, fins de ligne CR, CRLF, clés en casse libre', () => {
    const txt = '﻿user-AGENT: * # tous\r\nDISALLOW: /a # commentaire\rAllow: /a/b\r\n';
    expect(allows(txt, '/a/x')).toBe(false);
    expect(allows(txt, '/a/b')).toBe(true);
  });

  it('`/robots.txt` toujours permis', () => {
    expect(allows('User-agent: *\nDisallow: /\n', '/robots.txt')).toBe(true);
  });

  it('Crawl-delay du groupe retenu (le plus grand) ; valeur illisible ignorée', () => {
    const file = parseRobots('User-agent: *\nCrawl-delay: 5\nAllow: /\nUser-agent: Scrapyomama\nCrawl-delay: abc\nCrawl-delay: 2.5\n');
    expect(selectGroup(file).crawlDelaySeconds).toBe(2.5);
    expect(selectGroup(file, 'other').crawlDelaySeconds).toBe(5);
  });

  it('Sitemap et signaux (Content-Signal, Content-Usage) relevés comme données', () => {
    const file = parseRobots('Content-Usage: train-ai=n\nUser-agent: *\nContent-Signal: ai-train=no, search=yes\nAllow: /\nSitemap: https://zz-test.example/sitemap.xml\n');
    expect(file.sitemaps).toEqual(['https://zz-test.example/sitemap.xml']);
    expect(file.globalSignals).toEqual([{ key: 'content-usage', value: 'train-ai=n' }]);
    expect(selectGroup(file).signals).toEqual([{ key: 'content-signal', value: 'ai-train=no, search=yes' }]);
  });

  it('motif hostile (nombreux jokers) : correspondance en temps borné', () => {
    const pattern = `/${'*a'.repeat(500)}b`;
    const path = `/${'a'.repeat(5000)}`;
    const started = performance.now();
    expect(matchRules([{ allow: false, pattern }], path).allowed).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
