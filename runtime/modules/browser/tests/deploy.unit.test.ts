// SPDX-License-Identifier: AGPL-3.0-only
// Gabarits de déploiement de SYM Browser (cdc/sym-browser 06 tâche 5.1 ; 03 § 4 ; 04b § 9 et § 11 ; 04f § 8 ; 04g § 6) :
// Compose en mode `all` et en passerelle + nœuds, blueprint Render « SYM Browser seul », image GHCR multi-arch, guide.
// Contrôles statiques, sans Docker : variables du catalogue seulement, secrets jamais écrits en clair, confinement de
// Chromium (seccomp du module, no-new-privileges, capacités retirées), aucun port ouvert hors boucle locale par défaut.
// Le démarrage réel des gabarits est dans tests/deploy.e2e.test.ts (étape image de ci:local).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { MODULE_ROOT } from '../eslint.boundaries.mjs';
import { BROWSER_ENV_CATALOG, browserEnvNames } from '../packages/core/src/config/env-catalog.ts';
import { imageBuildCommand, IMAGE_NAME, IMAGE_PLATFORMS } from '../scripts/image-build.ts';

type Service = {
  image?: string;
  environment?: Record<string, string>;
  ports?: string[];
  profiles?: string[];
  security_opt?: string[];
  cap_drop?: string[];
  cap_add?: string[];
  shm_size?: string;
  healthcheck?: { test: string[] };
  depends_on?: Record<string, { condition: string }>;
  stop_grace_period?: string;
  volumes?: string[];
  networks?: string[] | Record<string, unknown>;
};
type Compose = { name?: string; services: Record<string, Service>; volumes?: Record<string, unknown>; networks?: Record<string, { internal?: boolean }> };

const DEPLOY = join(MODULE_ROOT, 'deploy');
const read = (file: string) => readFileSync(join(DEPLOY, file), 'utf8');
const compose = (file: string) => parse(read(file), { merge: true }) as Compose;
const FILES = ['compose.yaml', 'compose.nodes.yaml', 'compose.standalone.yaml'] as const;
const DEFAULT_IMAGE = '${SYMB_IMAGE:-ghcr.io/scrap-yo-mama/sym-browser:1}';
const SECRETS = new Set(BROWSER_ENV_CATALOG.filter((v) => v.secret).map((v) => v.name));
const browserServices = (c: Compose) => Object.entries(c.services).filter(([, s]) => s.image === DEFAULT_IMAGE);
const modeOf = (s: Service) => s.environment?.SYMB_MODE ?? 'all';

describe('fichiers livrés', () => {
  test.each(['compose.yaml', 'compose.nodes.yaml', 'compose.standalone.yaml', 'render.sym-browser.yaml', '.env.example', 'README.md', 'seccomp-chromium.json'])('deploy/%s présent', (file) => {
    expect(existsSync(join(DEPLOY, file)), file).toBe(true);
  });
});

describe.each(FILES)('Compose %s', (file) => {
  const c = compose(file);
  const services = browserServices(c);

  test('image ghcr.io/scrap-yo-mama/sym-browser, surchargeable par SYMB_IMAGE', () => {
    expect(services.length).toBeGreaterThan(0);
  });

  test('variables : uniquement celles du catalogue (04b § 11), aucune variable de SYM', () => {
    const known = browserEnvNames();
    for (const [name, s] of services) {
      for (const key of Object.keys(s.environment ?? {})) expect(known.has(key), `${name}.${key}`).toBe(true);
      expect(Object.keys(s.environment ?? {}).filter((k) => /^(BROWSER_|SYM_)/.test(k)), name).toEqual([]);
    }
  });

  test('secrets : jamais en clair, toujours exigés depuis l’environnement (${VAR:?…})', () => {
    for (const [name, s] of Object.entries(c.services)) {
      for (const [key, value] of Object.entries(s.environment ?? {})) {
        if (SECRETS.has(key) || /PASSWORD/.test(key)) expect(String(value), `${name}.${key}`).toMatch(/\$\{[A-Z_]+:\?[^}]+\}/);
      }
    }
    expect(read(file)).not.toMatch(/MASTER_KEY=[A-Za-z0-9+/]{43}=/);
  });

  test('confinement : seccomp du module, no-new-privileges, capacités retirées ; SYS_CHROOT seulement là où Chromium tourne', () => {
    for (const [name, s] of services) {
      expect(s.security_opt, name).toEqual(expect.arrayContaining(['seccomp=seccomp-chromium.json', 'no-new-privileges:true']));
      expect(s.cap_drop, name).toEqual(['ALL']);
      if (modeOf(s) === 'gateway') {
        expect(s.cap_add ?? [], name).toEqual([]);
      } else {
        // Le bac à sable de Chromium fait un chroot dans son espace de noms utilisateur : sans SYS_CHROOT dans l'ensemble
        // limitant, « Check failed: sys_chroot » (constaté dans l'image, 2026-10-02). Aucune capacité effective pour pwuser.
        expect(s.cap_add, name).toEqual(['SYS_CHROOT']);
        expect(s.shm_size, name).toBeDefined();
      }
    }
  });

  test('aucun port publié hors boucle locale par défaut ; ni base ni nœud publiés', () => {
    for (const [name, s] of Object.entries(c.services)) {
      for (const port of s.ports ?? []) {
        expect(modeOf(s), `${name} : seul le point d'entrée HTTP est publié`).not.toBe('node');
        expect(port, name).toMatch(/^\$\{SYMB_BIND:-127\.0\.0\.1:3000\}:3000$/);
      }
      if (s.image?.startsWith('postgres')) expect(s.ports ?? [], name).toEqual([]);
    }
  });

  test('santé : /readyz du service, démarrage après une base saine', () => {
    for (const [name, s] of services) {
      expect(s.healthcheck?.test.join(' '), name).toContain('/readyz');
      expect(s.depends_on?.postgres?.condition, name).toBe('service_healthy');
    }
  });

  test('PostgreSQL 16 à 18 épinglé par empreinte, sain avant les services', () => {
    const pg = c.services.postgres;
    expect(pg?.image).toMatch(/^postgres:(16|17|18)[.\w-]*@sha256:[0-9a-f]{64}$/);
    expect(pg?.healthcheck?.test.join(' ')).toContain('pg_isready');
    expect(pg?.environment?.POSTGRES_PASSWORD).toMatch(/\$\{POSTGRES_PASSWORD:\?/);
  });

  test('arrêt : la grâce de Compose couvre SHUTDOWN_GRACE_SECONDS (drainage 04b § 9, tâche 2.7)', () => {
    for (const [name, s] of services) {
      if (modeOf(s) === 'gateway') continue;
      const grace = Number(s.environment?.SHUTDOWN_GRACE_SECONDS ?? 270);
      expect(Number.parseInt(s.stop_grace_period ?? '0', 10), name).toBeGreaterThanOrEqual(grace + 20);
    }
  });
});

describe('Compose : topologies', () => {
  test('mode all : un seul service sym-browser (passerelle et nœud), volume de données, point d’entrée publié en boucle locale', () => {
    const c = compose('compose.yaml');
    const services = browserServices(c);
    expect(services.map(([name]) => name)).toEqual(['sym-browser']);
    const s = services[0]![1];
    expect(modeOf(s)).toBe('all');
    expect(s.volumes).toEqual(['sym-browser-data:/data']);
    expect(s.ports).toEqual(['${SYMB_BIND:-127.0.0.1:3000}:3000']);
  });

  test('multi-nœuds : passerelle + node-1, node-2 ajouté à chaud (profil scale), même NODE_TOKEN, NODE_ID et URL privée propres', () => {
    const c = compose('compose.nodes.yaml');
    const s = c.services;
    expect(modeOf(s.gateway!)).toBe('gateway');
    for (const id of ['node-1', 'node-2']) {
      const node = s[id]!;
      expect(node.environment).toMatchObject({ SYMB_MODE: 'node', NODE_ID: id, NODE_PUBLIC_URL: `http://${id}:3000` });
      expect(node.environment?.NODE_TOKEN).toBe(s.gateway!.environment?.NODE_TOKEN);
      expect(node.environment?.MASTER_KEY).toBe(s.gateway!.environment?.MASTER_KEY);
      expect(node.ports ?? []).toEqual([]);
    }
    expect(s['node-1']!.profiles).toBeUndefined();
    expect(s['node-2']!.profiles).toEqual(['scale']);
  });

  test('instance autonome (04f § 8) : aucun service SYM, réseau sans sortie vers Internet, seules base et MASTER_KEY requises', () => {
    const c = compose('compose.standalone.yaml');
    expect(Object.keys(c.services).sort()).toEqual(['postgres', 'sym-browser']);
    expect(Object.values(c.networks ?? {}).every((n) => n.internal === true)).toBe(true);
    const s = c.services['sym-browser']!;
    expect(Object.keys(s.environment ?? {}).sort()).toEqual(['DATABASE_URL', 'MASTER_KEY', 'SYMB_BOOTSTRAP_API_KEY', 'SYMB_MODE']);
  });
});

describe('Render : blueprint « SYM Browser seul » (passerelle web + nœud privé + PostgreSQL)', () => {
  type RenderService = { type: string; name: string; runtime: string; image?: { url: string }; plan?: string; healthCheckPath?: string; maxShutdownDelaySeconds?: number; envVars?: Array<Record<string, unknown>> };
  const blueprint = parse(read('render.sym-browser.yaml')) as { services: RenderService[]; databases: Array<{ name: string; postgresMajorVersion: string }>; envVarGroups: Array<{ name: string; envVars: Array<Record<string, unknown>> }> };
  const byType = (type: string) => blueprint.services.filter((s) => s.type === type);

  test('une passerelle web et un nœud pserv, même image GHCR, PostgreSQL 16 à 18', () => {
    expect(byType('web')).toHaveLength(1);
    expect(byType('pserv')).toHaveLength(1);
    for (const s of blueprint.services) {
      expect(s.runtime).toBe('image');
      expect(s.image?.url).toMatch(/^ghcr\.io\/scrap-yo-mama\/sym-browser:/);
    }
    expect(blueprint.databases).toHaveLength(1);
    expect(['16', '17', '18']).toContain(String(blueprint.databases[0]!.postgresMajorVersion));
  });

  test('modes et santé : passerelle gateway sur /readyz ; nœud node, maxShutdownDelaySeconds 300 (04b § 9)', () => {
    const env = (s: RenderService) => Object.fromEntries((s.envVars ?? []).filter((v) => typeof v.key === 'string').map((v) => [v.key as string, v]));
    const [web] = byType('web');
    const [node] = byType('pserv');
    expect(env(web!).SYMB_MODE?.value).toBe('gateway');
    expect(web!.healthCheckPath).toBe('/readyz');
    expect(env(node!).SYMB_MODE?.value).toBe('node');
    expect(node!.maxShutdownDelaySeconds).toBe(300);
    expect(env(node!).NODE_PUBLIC_URL?.fromService).toMatchObject({ type: 'pserv', name: node!.name, property: 'hostport' });
    for (const s of [web!, node!]) {
      expect(env(s).DATABASE_URL?.fromDatabase).toMatchObject({ name: blueprint.databases[0]!.name, property: 'connectionString' });
      for (const key of Object.keys(env(s))) expect(browserEnvNames().has(key), `${s.name}.${key}`).toBe(true);
    }
  });

  test('secrets générés par Render et partagés par groupe : MASTER_KEY (256 bits base64), NODE_TOKEN ; jamais de valeur écrite', () => {
    const group = blueprint.envVarGroups.find((g) => g.envVars.some((v) => v.key === 'MASTER_KEY'));
    expect(group?.envVars).toEqual(expect.arrayContaining([{ key: 'MASTER_KEY', generateValue: true }, { key: 'NODE_TOKEN', generateValue: true }]));
    for (const s of blueprint.services) expect((s.envVars ?? []).some((v) => v.fromGroup === group!.name), s.name).toBe(true);
    for (const v of [...blueprint.services.flatMap((s) => s.envVars ?? []), ...blueprint.envVarGroups.flatMap((g) => g.envVars)]) {
      if (SECRETS.has(String(v.key))) expect(v).not.toHaveProperty('value');
    }
  });
});

describe('image GHCR multi-arch (sans publication)', () => {
  test('linux/amd64 et linux/arm64, nom ghcr.io/scrap-yo-mama/sym-browser', () => {
    expect(IMAGE_NAME).toBe('ghcr.io/scrap-yo-mama/sym-browser');
    expect(IMAGE_PLATFORMS).toEqual(['linux/amd64', 'linux/arm64']);
  });

  test('par défaut : archive OCI locale, aucun push ; push seulement avec le GO explicite', () => {
    const local = imageBuildCommand({ version: '1.0.0', push: false, env: {} });
    expect(local.join(' ')).toContain('buildx build --platform linux/amd64,linux/arm64');
    expect(local.join(' ')).toContain('--output type=oci,dest=');
    expect(local).not.toContain('--push');
    expect(local.join(' ')).toContain(`--tag ${IMAGE_NAME}:1.0.0`);
    expect(local.join(' ')).toContain(`--tag ${IMAGE_NAME}:1`);
    expect(() => imageBuildCommand({ version: '1.0.0', push: true, env: {} })).toThrow(/GO/);
    expect(imageBuildCommand({ version: '1.0.0', push: true, env: { SYMB_PUBLISH_GO: 'oui' } })).toContain('--push');
    expect(() => imageBuildCommand({ version: 'latest', push: false, env: {} })).toThrow(/version/);
  });

  test('Dockerfile : build sur la plateforme de construction, étiquettes OCI (source, licence), /data à pwuser', () => {
    const dockerfile = readFileSync(join(MODULE_ROOT, 'Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/FROM --platform=\$BUILDPLATFORM \$\{PLAYWRIGHT_IMAGE\} AS build/);
    expect(dockerfile).toContain('org.opencontainers.image.source="https://github.com/scrap-yo-mama/sym-browser"');
    expect(dockerfile).toContain('org.opencontainers.image.licenses="AGPL-3.0-only"');
    expect(dockerfile).toMatch(/install -d -o pwuser -g pwuser \/data/);
  });
});

describe('guide de déploiement (deploy/README.md)', () => {
  const guide = read('README.md');
  test.each([
    '## Installation sur une VM',
    '## Docker Compose : mode all',
    '## Plusieurs nœuds',
    '## Render : SYM Browser seul',
    '## Topologies : avec SYM ou isolée',
    '## Image multi-arch',
    '## Arrêt et mise à jour',
  ])('section « %s »', (heading) => {
    expect(guide).toContain(heading);
  });

  test('commandes de génération des secrets, aucune valeur de secret', () => {
    expect(guide).toContain('pnpm --filter @sym-browser/core keygen');
    expect(guide).toContain('pnpm --filter @sym-browser/core apikey');
    expect(guide).not.toMatch(/symb_[A-Za-z0-9]{12}_[A-Za-z0-9_-]{43}/);
    expect(guide).not.toMatch(/[A-Za-z0-9+/]{43}=/);
  });
});
