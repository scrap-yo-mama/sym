// SPDX-License-Identifier: AGPL-3.0-only
// robots.txt, source d'information (D-91) : lignes `Sitemap` d'un robots.txt lu comme une page, sans aucun verdict.
import { describe, expect, it } from 'vitest';
import * as access from './index.js';
import { robotsSitemaps } from './robots.js';

describe('robotsSitemaps : le sitemap d’un robots.txt que l’agent a choisi de lire', () => {
  it('lignes Sitemap (casse de la clé ignorée), commentaires, BOM, doublons, URL relatives résolues', () => {
    const text = '\uFEFFUser-agent: *\nDisallow: /\nSitemap: https://zz-test.example/sitemap.xml # principal\nsitemap: /news-sitemap.xml\nSITEMAP: https://zz-test.example/sitemap.xml\n';
    expect(robotsSitemaps(text, 'https://zz-test.example/robots.txt')).toEqual(['https://zz-test.example/sitemap.xml', 'https://zz-test.example/news-sitemap.xml']);
  });

  it('URL illisible, schéma autre que http(s) ou identifiants : ignorés ou retirés', () => {
    const text = 'Sitemap: javascript:alert(1)\nSitemap: ftp://zz-test.example/s.xml\nSitemap: https://u:p@zz-test.example/s.xml#x\nSitemap: /relative.xml\nSitemap:\n';
    expect(robotsSitemaps(text)).toEqual(['https://zz-test.example/s.xml']);
  });

  it('fichier hostile : au plus 50 sitemaps, ligne démesurée ignorée, jamais d’exception', () => {
    const many = Array.from({ length: 200 }, (_, i) => `Sitemap: https://zz-test.example/s${i}.xml`).join('\n');
    expect(robotsSitemaps(many)).toHaveLength(50);
    expect(robotsSitemaps(`Sitemap: https://zz-test.example/${'a'.repeat(10_000)}`)).toEqual([]);
    expect(() => robotsSitemaps('\u0000\r\n:\n::::')).not.toThrow();
  });

  it('assert_robots_not_gating — le module d’accès n’expose aucun verdict robots.txt', () => {
    const names = Object.keys(access);
    expect(names.filter((n) => /robots/i.test(n))).toEqual(['robotsSitemaps']);
    expect(names.filter((n) => /gate|crawl|disallow/i.test(n))).toEqual([]);
  });
});
