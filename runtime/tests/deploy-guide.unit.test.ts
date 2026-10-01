// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.1 (vérification) : le guide de déploiement ne déclare pas atteint ce qui ne l'est pas. Les réserves connues sont
// consignées dans « Statut de vérification », chacune avec la tâche qui doit la lever.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const runtimeDir = new URL('..', import.meta.url).pathname;
const guide = readFileSync(join(runtimeDir, 'docs/deploiement.md'), 'utf8');
const status = guide.slice(guide.indexOf('## Statut de vérification'));

describe('assert_deploy_guide_reserves : statut de vérification honnête (4.1)', () => {
  test('la section existe et nomme la tâche 4.1 « livrée avec réserves »', () => {
    expect(guide).toContain('## Statut de vérification');
    expect(status).toMatch(/livrée avec réserves/);
  });

  test('réserve MCP : critère non atteint, dépendance 3.2 levée par D-28, à rejouer par verify.sh après la fusion de 3.2', () => {
    expect(status).toMatch(/Réserve MCP/);
    expect(status).toMatch(/D-28/);
    expect(status).toMatch(/3\.2/);
    expect(status).toMatch(/verify\.sh/);
  });

  test('réserve console : « l’assistant s’affiche » non atteint ; vue /setup (3.8) et service de la console par le server nommés', () => {
    expect(status).toMatch(/Réserve console/);
    expect(status).toMatch(/l'assistant s'affiche/);
    expect(status).toMatch(/3\.8/);
    expect(status).toMatch(/@fastify\/static/);
  });

  test('constat de conformité au schéma Render daté, avec l’empreinte du schéma et la commande de rejeu', () => {
    expect(status).toMatch(/schéma officiel de Render.*\d{4}-\d{2}-\d{2}/s);
    expect(status).toMatch(/sha256 [0-9a-f]{12}/);
    expect(guide).toMatch(/RENDER_SCHEMA=/);
  });

  test('écarts au CDC assumés et consignés : ni `init` ni `ipc: host` (14 § 12) ; dimensionnement à confirmer par 4.4', () => {
    expect(status).toMatch(/14 § 12/);
    expect(status).toMatch(/ipc: host/);
    expect(status).toMatch(/4\.4/);
  });

  test('Heroku : démarrage des dynos (ENTRYPOINT sans CMD, `run` explicite) consigné dans « Reste »', () => {
    expect(status).toMatch(/\| Heroku \|.*ENTRYPOINT/);
  });
});
