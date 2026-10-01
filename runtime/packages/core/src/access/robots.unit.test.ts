// SPDX-License-Identifier: AGPL-3.0-only
// robots.txt, RFC 9309 (tâche 1.11) : groupes, jeton produit puis `*`, règle la plus longue, `Allow` à égalité, `*` et
// `$`, encodage pourcent, `/robots.txt` toujours permis, `Crawl-delay`, signaux, motifs hostiles.
import { describe, expect, it } from 'vitest';
import { matchRules, MAX_ROBOTS_TARGET, normalizeOctets, parseRobots, robotsAllows, selectGroup } from './robots.js';

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

  it('groupe du jeton produit (casse ignorée, version ignorée) ET groupe `*` : un chemin interdit par l’un ou l’autre est interdit', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: scrapyomama/2.0\nAllow: /\nDisallow: /admin\n';
    // `*` interdit tout : le groupe du jeton ne lève pas cette interdiction (17 §2).
    expect(allows(txt, '/page')).toBe(false);
    expect(allows(txt, '/admin/x')).toBe(false);
    expect(allows(txt, '/page', 'OtherBot')).toBe(false);
    expect(selectGroup(parseRobots(txt)).matched).toBe('token');
    // Interdiction dans le seul groupe `*` : jeton envoyé ou non, même résultat ; dans le seul groupe du jeton, aussi.
    const star = 'User-agent: *\nDisallow: /prive\n\nUser-agent: Scrapyomama\nDisallow: /autre\n';
    expect(allows(star, '/prive/x')).toBe(false);
    expect(allows(star, '/autre/x')).toBe(false);
    expect(allows(star, '/public')).toBe(true);
    expect(allows('User-agent: Scrapyomama\nDisallow: /prive\n', '/prive/x')).toBe(false);
    expect(allows('User-agent: *\nDisallow: /prive\n', '/prive/x')).toBe(false);
    expect(allows('User-agent: *\nDisallow: /prive\n\nUser-agent: Scrapyomama\nAllow: /\n', '/prive/x')).toBe(false);
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

  it('Crawl-delay : le plus grand des groupes du jeton ET de `*` (le plus strict gagne) ; valeur illisible ignorée', () => {
    const file = parseRobots('User-agent: *\nCrawl-delay: 5\nAllow: /\nUser-agent: Scrapyomama\nCrawl-delay: abc\nCrawl-delay: 2.5\n');
    expect(selectGroup(file).crawlDelaySeconds).toBe(5);
    expect(selectGroup(file, 'other').crawlDelaySeconds).toBe(5);
    // Crawl-delay dans le seul groupe `*` : plancher de cadence appliqué même si un groupe du jeton existe (17 §2, §5).
    expect(selectGroup(parseRobots('User-agent: *\nCrawl-delay: 10\nAllow: /\n\nUser-agent: Scrapyomama\nDisallow: /prive\n')).crawlDelaySeconds).toBe(10);
    expect(selectGroup(parseRobots('User-agent: *\nAllow: /\n\nUser-agent: Scrapyomama\nCrawl-delay: 3\n')).crawlDelaySeconds).toBe(3);
  });

  it('signaux d’accès des groupes du jeton ET de `*`, sans doublon quand un groupe porte les deux', () => {
    const file = parseRobots('User-agent: *\nContent-Signal: ai-train=no\nDisallow: /a\n\nUser-agent: Scrapyomama\nContent-Signal: search=yes\nDisallow: /b\n');
    expect(selectGroup(file).signals).toEqual([
      { key: 'content-signal', value: 'search=yes' },
      { key: 'content-signal', value: 'ai-train=no' },
    ]);
    const shared = parseRobots('User-agent: Scrapyomama\nUser-agent: *\nContent-Signal: ai-train=no\nCrawl-delay: 4\nDisallow: /x\n');
    expect(selectGroup(shared).signals).toEqual([{ key: 'content-signal', value: 'ai-train=no' }]);
    expect(selectGroup(shared).crawlDelaySeconds).toBe(4);
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

  // Revue de 1.11 : un robots.txt hostile de 500 Kio (des milliers de règles à jokers) et des URL longues ne bloquent pas
  // la boucle d'événements du worker (contrôle de chaque sous-ressource de la page).
  it('fichier hostile de 500 Kio et chemin de 8 Kio : chaque contrôle en temps borné', () => {
    let txt = 'User-agent: *\n';
    for (let i = 0; txt.length < 500 * 1024; i++) txt += `Disallow: /a*a*a*b${i}\n`;
    const rules = selectGroup(parseRobots(txt)).rules;
    expect(rules.length).toBeGreaterThan(15_000);
    const path = `/${'a'.repeat(8 * 1024 - 1)}`;
    // Meilleur de 10 essais : une dérive de complexité ralentit chaque essai, alors qu'une préemption de la machine
    // chargée (CI parallèles) n'en ralentit qu'une partie ; la moyenne rendait le test instable sous charge.
    let best = Infinity;
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      expect(matchRules(rules, path).allowed).toBe(true);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(50);
    // Règle effective toujours appliquée (aucune règle écartée par un plafond).
    expect(matchRules(rules, `/${'a'.repeat(100)}b${Math.floor(rules.length / 2)}`).allowed).toBe(false);
  });

  // Revue de 1.11 : un plafond global de 20 000 règles écartait sans bruit le groupe `*` placé après 20 000 règles d'autres
  // robots (fichier légitime de 349 Kio, sous la borne des 500 Kio) : le chemin interdit était requêté.
  it('aucune règle écartée : 20 000 règles d’un autre robot puis le groupe `*`, dans les 500 Kio', () => {
    let txt = 'User-agent: Googlebot\n';
    for (let i = 0; i < 20_000; i++) txt += `Disallow: /x${i}\n`;
    txt += 'User-agent: *\nDisallow: /prive/\n';
    expect(Buffer.byteLength(txt)).toBeLessThan(500 * 1024);
    expect(robotsAllows(parseRobots(txt), new URL('https://zz-test.example/prive/a'))).toEqual({ allowed: false, rule: 'Disallow: /prive/' });
  });

  it('500 Kio de règles les plus courtes possibles : la dernière règle du groupe retenu s’applique', () => {
    let txt = 'User-agent: *\n';
    const line = 'allow:a\n';
    while (txt.length + line.length < 500 * 1024 - 32) txt += line;
    txt += 'Disallow: /prive/\n';
    const rules = selectGroup(parseRobots(txt)).rules;
    expect(rules.length).toBeGreaterThan(60_000);
    expect(allows(txt, '/prive/a')).toBe(false);
    // Meilleur de 10 essais (comme le test voisin) : la moyenne était faussée par une préemption sous CI parallèles.
    let best = Infinity;
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      matchRules(rules, `/${'a'.repeat(8 * 1024 - 1)}`);
      best = Math.min(best, performance.now() - started);
    }
    expect(best).toBeLessThan(50);
  });

  it('chemin et requête au-delà de 8 Kio : refus par précaution (s\'il existe des règles)', () => {
    const long = `/${'x'.repeat(MAX_ROBOTS_TARGET)}`;
    expect(matchRules([{ allow: false, pattern: '/prive/' }], long)).toEqual({ allowed: false, rule: null });
    expect(matchRules([], long).allowed).toBe(true);
    expect(allows('User-agent: *\nDisallow: /prive/\n', `/public?q=${'x'.repeat(MAX_ROBOTS_TARGET)}`)).toBe(false);
  });
});
