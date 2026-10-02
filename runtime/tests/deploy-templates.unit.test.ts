// SPDX-License-Identifier: AGPL-3.0-only
// Tâche 4.1 (14 § 12) : validation STATIQUE des modèles d'hébergement (aucun hébergeur n'est contacté) : render.yaml,
// docker-compose.prod.yml, modèle Railway, heroku.yml. Les mêmes invariants valent pour tous : image épinglée X.Y.Z, aucun
// secret littéral, MASTER_KEY partagée entre server et worker, variables toutes présentes au catalogue.
import { ENV_CATALOG, envVariableNames, MasterKey } from '@runtime/core';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';

const runtimeDir = new URL('..', import.meta.url).pathname;
const repoDir = join(runtimeDir, '..');
const deployDir = join(runtimeDir, 'deploy');
/** Render ne lit le Blueprint (et son bouton « Deploy to Render ») qu'à la RACINE du dépôt : source unique, hors de deploy/. */
const RENDER_YAML = join(repoDir, 'render.yaml');
const text = (path: string) => readFileSync(path === 'render.yaml' ? RENDER_YAML : join(deployDir, path), 'utf8');
const yaml = <T>(path: string): T => parse(text(path)) as T;
const version = (JSON.parse(readFileSync(join(runtimeDir, 'package.json'), 'utf8')) as { version: string }).version;

const IMAGE_REPO = 'ghcr.io/scrap-yo-mama/sym';
const PINNED = new RegExp(`^${IMAGE_REPO.replace(/[./]/g, '\\$&')}:\\d+\\.\\d+\\.\\d+(-beta\\.\\d+)?$`);
const catalog = envVariableNames();
/** Variables qui ne sont pas des variables de l'application : propres à l'hébergeur ou à compose. */
const PLATFORM_ONLY = new Set(['PGSSLMODE']);

describe('assert_deploy_templates_static : image épinglée X.Y.Z dans chaque modèle (jamais `latest`, 16 § 3)', () => {
  const pins = (): Record<string, string[]> => {
    const compose = text('docker-compose.prod.yml').match(/\$\{RUNTIME_IMAGE:-([^}]+)\}/)?.[1];
    const render = yaml<{ services: { image: { url: string } }[] }>('render.yaml').services.map((s) => s.image.url);
    const railway = yaml<{ image: string }>('railway/template.yaml').image;
    const heroku = ['Dockerfile.web', 'Dockerfile.worker'].map((f) => text(`heroku/${f}`).match(/^FROM (\S+)$/m)?.[1] ?? '');
    return { compose: [compose ?? ''], render, railway: [railway], heroku };
  };

  test('même dépôt GHCR, tag SemVer exact, jamais latest ; égal à la version du dépôt (release-please les aligne)', () => {
    for (const [target, refs] of Object.entries(pins())) {
      expect(refs.length, target).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref, target).toMatch(PINNED);
        expect(ref, target).not.toMatch(/latest|stable|beta$/);
        expect(ref.split(':')[1], `${target} doit suivre la version du dépôt`).toBe(version);
      }
    }
  });

  test('chaque épingle porte un marqueur release-please (ligne ou bloc), pour que la version suive les releases', () => {
    expect(text('docker-compose.prod.yml')).toMatch(/\{RUNTIME_IMAGE:-[^}]+\} # x-release-please-version/);
    expect(text('render.yaml').match(/# x-release-please-version/g)?.length).toBe(2);
    expect(text('railway/template.yaml')).toMatch(/^image: \S+ # x-release-please-version$/m);
    for (const f of ['Dockerfile.web', 'Dockerfile.worker']) expect(text(`heroku/${f}`)).toMatch(/# x-release-please-start-version\nFROM \S+\n# x-release-please-end/);
  });

  test('les fichiers à épingler sont déclarés dans les deux configurations release-please', () => {
    for (const name of ['release-please-config.json', 'release-please-config.beta.json']) {
      const config = JSON.parse(readFileSync(join(repoDir, name), 'utf8')) as { packages: { runtime: { 'extra-files': { type: string; path: string }[] } } };
      const generic = config.packages.runtime['extra-files'].filter((f) => f.type === 'generic').map((f) => f.path).sort();
      // Chemin en « / » : relatif à la racine du dépôt et non au paquet runtime (release-please 17.6.0, Strategy.addPath).
      expect(generic, name).toEqual(['/render.yaml', 'deploy/docker-compose.prod.yml', 'deploy/heroku/Dockerfile.web', 'deploy/heroku/Dockerfile.worker', 'deploy/railway/template.yaml']);
      for (const path of generic) expect(existsSync(path.startsWith('/') ? join(repoDir, path) : join(runtimeDir, path)), path).toBe(true);
    }
  });
});

describe('assert_deploy_templates_static : bouton « Deploy to Render » (14 § 12, à valider au GO)', () => {
  const BADGE = '[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/scrap-yo-mama/sym)';

  test('render.yaml est à la racine du dépôt, en un seul exemplaire (Render ne lit le Blueprint du bouton qu’à la racine)', () => {
    expect(existsSync(RENDER_YAML)).toBe(true);
    expect(existsSync(join(deployDir, 'render.yaml')), 'copie divergente possible : une seule source').toBe(false);
  });

  test('le badge pointe sur le dépôt (paramètre repo explicite) ; présent dans le guide et dans deploy/README.md', () => {
    expect(readFileSync(join(runtimeDir, 'docs/deploiement.md'), 'utf8')).toContain(BADGE);
    expect(readFileSync(join(deployDir, 'README.md'), 'utf8')).toContain(BADGE);
  });
});

describe('render.yaml : cible de référence (bloquante)', () => {
  type Env = { key?: string; value?: string; sync?: boolean; generateValue?: boolean; fromGroup?: string; fromDatabase?: { name: string; property: string } };
  type Service = { type: string; name: string; runtime: string; region: string; plan: string; healthCheckPath?: string; preDeployCommand?: string; autoDeployTrigger?: string; envVars: Env[] };
  const doc = yaml<{ envVarGroups: { name: string; envVars: Env[] }[]; services: Service[]; databases: { name: string; region: string; postgresMajorVersion: string; plan: string; diskSizeGB: number; ipAllowList: unknown[] }[] }>('render.yaml');
  const web = doc.services.find((s) => s.type === 'web')!;
  const worker = doc.services.find((s) => s.type === 'worker')!;
  const db = doc.databases[0]!;
  const env = (service: Service, key: string) => service.envVars.find((e) => e.key === key);

  test('un web et un worker tirant l’image (pas de build depuis des sources), une base, dans la même région', () => {
    expect(doc.services.map((s) => s.type).sort()).toEqual(['web', 'worker']);
    for (const service of doc.services) {
      expect(service.runtime).toBe('image');
      expect(service.region).toBe(db.region);
      expect(service.plan).not.toBe('free');
      expect(service.autoDeployTrigger).toBe('off'); // jamais de redéploiement par un push : la mise à jour est explicite
    }
    expect(doc.databases).toHaveLength(1);
  });

  test('web : sonde /api/ready, migration en pré-déploiement, un saut de proxy, PUBLIC_URL demandée, jeton généré', () => {
    expect(web.healthCheckPath).toBe('/api/ready');
    expect(web.preDeployCommand).toBe('runtime migrate');
    expect(env(web, 'RUNTIME_MODE')?.value).toBe('server');
    expect(env(web, 'TRUST_PROXY')?.value).toBe('1');
    expect(env(web, 'PUBLIC_URL')).toEqual({ key: 'PUBLIC_URL', sync: false });
    expect(env(web, 'ADMIN_BOOTSTRAP_TOKEN')?.generateValue).toBe(true);
    expect(env(web, 'ADMIN_BOOTSTRAP_TOKEN')?.value).toBeUndefined();
  });

  test('worker : ne migre jamais (14 § 5), pas de sonde HTTP, mode worker, mémoire d’au moins 2 Go (1 run navigateur, 14 § 11)', () => {
    expect(worker.preDeployCommand).toBeUndefined();
    expect(worker.healthCheckPath).toBeUndefined();
    expect(env(worker, 'RUNTIME_MODE')?.value).toBe('worker');
    expect(Number(worker.plan.match(/-(\d+)g$/)?.[1])).toBeGreaterThanOrEqual(2);
  });

  test('dimensionnement du web aligné : mémoire du plan Render = plafond du server dans le compose (à confirmer par 4.4)', () => {
    const mb = Number(web.plan.match(/-(\d+)mb$/)?.[1]);
    const compose = yaml<{ services: Record<string, { mem_limit?: string }> }>('docker-compose.prod.yml').services['server']!.mem_limit;
    expect(mb).toBeGreaterThan(0);
    expect(compose).toBe(`${mb}m`);
  });

  test('MASTER_KEY générée UNE fois (groupe) et partagée : deux `generateValue` séparés donneraient deux clés différentes', () => {
    const group = doc.envVarGroups.find((g) => g.name === 'scrapyomama-runtime-secrets')!;
    expect(group.envVars).toEqual([{ key: 'MASTER_KEY', generateValue: true }]);
    for (const service of [web, worker]) {
      expect(service.envVars.filter((e) => e.fromGroup).map((e) => e.fromGroup)).toEqual([group.name]);
      expect(env(service, 'MASTER_KEY'), 'MASTER_KEY ne se redéfinit pas dans le service').toBeUndefined();
    }
    // Ce que Render génère (256 bits en base64) est exactement ce que MASTER_KEY exige.
    expect(() => MasterKey.parse(randomBytes(32).toString('base64'))).not.toThrow();
  });

  test('base privée (aucune IP autorisée), PostgreSQL 16, au moins 10 Go ; les deux services y vont par la connexion interne', () => {
    expect(db.ipAllowList).toEqual([]);
    expect(Number(db.postgresMajorVersion)).toBeGreaterThanOrEqual(15);
    expect(db.diskSizeGB).toBeGreaterThanOrEqual(10);
    expect(db.plan).not.toBe('free');
    for (const service of [web, worker]) {
      expect(env(service, 'DATABASE_URL')?.fromDatabase).toEqual({ name: db.name, property: 'connectionString' });
      expect(env(service, 'STORAGE_PLAN_GB')?.value).toBe(String(db.diskSizeGB)); // garde disque alignée sur l’offre
    }
  });

  test('aucune valeur secrète littérale ; seules des variables du catalogue ; `value` réservé aux réglages non secrets', () => {
    const literal = new Set(['RUNTIME_MODE', 'TRUST_PROXY', 'STORAGE_PLAN_GB']);
    for (const service of doc.services) {
      for (const e of service.envVars.filter((x) => x.key)) {
        expect(catalog.has(e.key!), e.key).toBe(true);
        if (e.value !== undefined) expect(literal.has(e.key!), `${e.key} littéral`).toBe(true);
      }
    }
  });
});

// Schéma officiel des Blueprints (https://render.com/schema/render.yaml.json) : il n'est PAS versionné ici (aucune licence
// publiée par Render). Rejeu : télécharger le schéma puis RENDER_SCHEMA=<fichier> (commande dans docs/deploiement.md).
describe('render.yaml : conforme au schéma officiel de Render (rejeu manuel, RENDER_SCHEMA)', () => {
  const schemaPath = process.env['RENDER_SCHEMA'];
  test.skipIf(!schemaPath)('render.yaml valide contre le schéma téléchargé (ajv, JSON Schema 2020-12)', () => {
    const validate = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(JSON.parse(readFileSync(schemaPath!, 'utf8')) as object);
    const ok = validate(parse(text('render.yaml')));
    expect(validate.errors ?? null, JSON.stringify(validate.errors)).toBeNull();
    expect(ok).toBe(true);
  });
});

describe('assert_compose_chromium_seccomp — profil seccomp de Chromium (deploy/seccomp-chromium.json) et compose de développement', () => {
  type Rule = { names: string[]; action: string; args?: unknown[]; includes?: { caps?: string[] }; excludes?: { caps?: string[] }; errnoRet?: number };
  const profile = JSON.parse(text('seccomp-chromium.json')) as { defaultAction: string; syscalls: Rule[] };
  const unconditional = (r: Rule) => r.action === 'SCMP_ACT_ALLOW' && (r.args ?? []).length === 0 && (r.includes?.caps ?? []).length === 0;

  test('profil par défaut de Docker plus la règle de Playwright (clone, setns, unshare) sans condition, rien d’autre de dangereux', () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    const allowed = new Set(profile.syscalls.filter(unconditional).flatMap((r) => r.names));
    // Règle exacte et empreinte du reste du profil : test « profil seccomp du worker » plus bas (fix-pnpm-pin, D-57).
    for (const userns of ['clone', 'setns', 'unshare']) expect(allowed.has(userns), userns).toBe(true);
    for (const forbidden of ['mount', 'umount2', 'pivot_root', 'bpf', 'kexec_load', 'init_module', 'finit_module', 'open_by_handle_at', 'perf_event_open', 'keyctl', 'add_key']) {
      expect(allowed.has(forbidden), forbidden).toBe(false);
    }
    // clone3 : ENOSYS sans CAP_SYS_ADMIN (glibc se replie sur clone).
    expect(profile.syscalls.find((r) => r.names.includes('clone3') && r.action === 'SCMP_ACT_ERRNO')?.errnoRet).toBe(38);
  });

  test('compose de développement : même sonde de santé descendue sur pwuser, même profil seccomp pour le worker (revue 4.1b)', () => {
    const dev = parse(readFileSync(join(runtimeDir, 'docker-compose.yml'), 'utf8')) as { services: Record<string, { image?: string; healthcheck?: { test: string[] }; security_opt?: string[] }> };
    const runtimeServices = Object.entries(dev.services).filter(([, svc]) => svc.image === 'runtime:dev');
    expect(runtimeServices.map(([n]) => n).sort()).toEqual(['migrate', 'server', 'worker']);
    for (const [name, svc] of runtimeServices) {
      if (svc.healthcheck?.test[0] === 'CMD') expect(svc.healthcheck.test.slice(0, 8), name).toEqual(['CMD', '/usr/bin/setpriv', '--reuid=1001', '--regid=1001', '--init-groups', '--inh-caps=-all', '--no-new-privs', '--']);
      expect(svc.healthcheck?.test[0] ?? 'CMD', name).not.toBe('CMD-SHELL');
    }
    expect(dev.services['server']!.healthcheck!.test[0]).toBe('CMD');
    expect(dev.services['worker']!.security_opt).toEqual(['seccomp=./deploy/seccomp-chromium.json']);
  });
});

describe('assert_compose_guide_matches_prod — guide publié « Déployer avec Docker Compose » aligné sur deploy/docker-compose.prod.yml (revue 4.1b)', () => {
  type Svc = { healthcheck?: { test?: string[] }; [k: string]: unknown };
  const guideText = readFileSync(join(runtimeDir, 'apps/docs/content/guides/docker-compose.md'), 'utf8');
  const guideYaml = /```yaml\n([\s\S]*?)```/.exec(guideText)?.[1] ?? '';
  const guide = parse(guideYaml) as { services: Record<string, Svc> };
  const prod = yaml<{ services: Record<string, Svc> }>('docker-compose.prod.yml');
  /** Champs de sécurité d'un service : ceux que le modèle de privilèges et le bac à sable de Chromium exigent ou excluent. */
  const SECURITY_FIELDS = ['security_opt', 'cap_add', 'cap_drop', 'user', 'privileged', 'ipc', 'pid', 'userns_mode', 'read_only', 'init'] as const;

  test('server, worker, migrate : mêmes champs de sécurité que le compose de production (profil seccomp de Chromium, pas d’ipc: host)', () => {
    for (const name of ['migrate', 'server', 'worker']) {
      for (const field of SECURITY_FIELDS) expect(guide.services[name]?.[field], `${name}.${field}`).toEqual(prod.services[name]?.[field]);
    }
    expect(guide.services['worker']?.['security_opt']).toEqual(['seccomp=./seccomp-chromium.json']);
  });

  test('sonde de santé du server : celle du compose de production, descendue sur pwuser (D-32)', () => {
    expect(guide.services['server']?.healthcheck?.test).toEqual(prod.services['server']?.healthcheck?.test);
  });

  test('le guide dit où prendre seccomp-chromium.json et le pose à côté du fichier Compose', () => {
    expect(guideText).toMatch(/curl -fsSLO https:\/\/raw\.githubusercontent\.com\/scrap-yo-mama\/sym\/[^/\s]+\/runtime\/deploy\/seccomp-chromium\.json/);
    expect(guideText).toMatch(/No usable sandbox!/);
  });
});

describe('docker-compose.prod.yml : cible bloquante', () => {
  type Svc = { image?: string; environment?: Record<string, string>; depends_on?: Record<string, { condition: string }>; healthcheck?: { test: string[] }; mem_limit?: string; ports?: string[]; [k: string]: unknown };
  const doc = yaml<{ services: Record<string, Svc> }>('docker-compose.prod.yml');
  const raw = text('docker-compose.prod.yml');
  const COMPOSE_ONLY = new Set(['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB']);

  test('le fichier est du YAML valide (les messages `${VAR:?…}` sont entre guillemets : un `: ` les casse)', () => {
    expect(Object.keys(doc.services).sort()).toEqual(['migrate', 'postgres', 'server', 'worker']);
    for (const line of raw.split('\n').filter((l) => l.includes(':?'))) expect(line, line).toMatch(/: "\$\{[A-Z_]+:\?[^"]*\}"$/);
  });

  test('ordre de démarrage : postgres sain, puis migrate terminé avec succès, puis server et worker', () => {
    expect(doc.services['migrate']!.depends_on).toEqual({ postgres: { condition: 'service_healthy' } });
    for (const name of ['server', 'worker']) {
      expect(doc.services[name]!.depends_on, name).toEqual({ postgres: { condition: 'service_healthy' }, migrate: { condition: 'service_completed_successfully' } });
    }
    expect(doc.services['migrate']!.environment!['RUNTIME_MODE']).toBe('migrate');
    expect(doc.services['server']!.environment!['RUNTIME_MODE']).toBe('server');
    expect(doc.services['worker']!.environment!['RUNTIME_MODE']).toBe('worker');
  });

  test('sondes : postgres (pg_isready) et server (/api/ready, 200 sinon échec) ; plafond mémoire sur chaque service', () => {
    expect(doc.services['postgres']!.healthcheck!.test.join(' ')).toMatch(/pg_isready/);
    expect(doc.services['server']!.healthcheck!.test.join(' ')).toMatch(/\/api\/ready/);
    // Lancée en root par Docker (USER root de l'image) : la sonde descend sur pwuser sans capacité (revue de F-20261001-R01).
    expect(doc.services['server']!.healthcheck!.test.slice(0, 8)).toEqual(['CMD', '/usr/bin/setpriv', '--reuid=1001', '--regid=1001', '--init-groups', '--inh-caps=-all', '--no-new-privs', '--']);
    for (const [name, svc] of Object.entries(doc.services)) expect(svc.mem_limit, name).toBeTruthy();
  });

  test('port publié sur 127.0.0.1 par défaut (pas de TLS intégré), jamais celui de la base', () => {
    expect(doc.services['server']!.ports).toEqual(['${BIND_ADDRESS:-127.0.0.1}:${SERVER_PORT:-3000}:3000']);
    expect(doc.services['postgres']!.ports).toBeUndefined();
    expect(doc.services['worker']!.ports).toBeUndefined();
  });

  test('aucune option qui affaiblit l’hôte ou casse le bac à sable (INV7) : ni ipc host, ni privileged, ni no-new-privileges, ni cap_drop', () => {
    for (const [name, svc] of Object.entries(doc.services)) {
      for (const forbidden of ['ipc', 'privileged', 'network_mode', 'pid', 'cap_add', 'cap_drop', 'devices']) expect(svc[forbidden], `${name}.${forbidden}`).toBeUndefined();
      // security_opt : seulement le profil seccomp du worker (jamais unconfined, ni no-new-privileges posé ici).
      expect(svc['security_opt'], `${name}.security_opt`).toEqual(name === 'worker' ? ['seccomp=./seccomp-chromium.json'] : undefined);
    }
    expect(raw).not.toMatch(/^\s*init: true/m); // l'image embarque tini
  });

  test('profil seccomp du worker : celui de Docker 28.0.4 (moby, profiles/seccomp/default.json) plus la seule entrée de Playwright pour les espaces de noms utilisateur', () => {
    type Rule = { comment?: string; names: string[]; action: string; args?: unknown[] | null; includes?: Record<string, unknown>; excludes?: Record<string, unknown> };
    const profile = JSON.parse(text('seccomp-chromium.json')) as { defaultAction: string; syscalls: Rule[] };
    const userns = { comment: 'Allow create user namespaces', names: ['clone', 'setns', 'unshare'], action: 'SCMP_ACT_ALLOW', args: [], includes: {}, excludes: {} };
    expect(profile.syscalls.filter((r) => r.comment === userns.comment)).toEqual([userns]);
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    // Le reste est octet pour octet le profil par défaut de Docker 28.0.4 (moby v28.0.4, sha256 du fichier amont) : rien
    // d'autre n'est ouvert (mount, ptrace, bpf… restent sous leurs capacités).
    const upstream = { ...profile, syscalls: profile.syscalls.filter((r) => r.comment !== userns.comment) };
    expect(createHash('sha256').update(JSON.stringify(upstream, null, '\t')).digest('hex')).toBe('9c1025c88ccaa517b648da571961838744ea2137f176bfe6a48b21294cae9c76');
  });

  test('profil seccomp documenté : à fournir à côté du compose (Coolify, Dokploy compris), limite Render, risque résiduel des espaces de noms utilisateur', () => {
    const guide = readFileSync(join(runtimeDir, 'docs/deploiement.md'), 'utf8');
    const section = (heading: string) => guide.slice(guide.indexOf(heading), guide.indexOf('\n## ', guide.indexOf(heading) + heading.length));
    const compose = section('## Docker Compose');
    // Sans le fichier, le conteneur worker ne peut pas être créé (security_opt du worker).
    expect(compose).toMatch(/`deploy\/seccomp-chromium\.json`[^\n]*\n?[^\n]*à côté/);
    const coolify = compose.split('\n- ').find((b) => b.startsWith('Coolify et Dokploy'));
    expect(coolify).toContain('seccomp-chromium.json');
    expect(coolify).toContain('(../apps/docs/content/guides/docker-compose.md)');
    // Render : le cas simulé applique le profil livré ; le seccomp réel de Render n'est pas vérifié (D-57).
    const render = guide.split('\n').find((l) => l.startsWith('| Render |'));
    const reste = render?.split(' | ').at(-1) ?? '';
    expect(reste).toMatch(/seccomp réel de Render/);
    expect(reste).toContain('D-57');
    expect(reste).toContain('zz-test');
    // Risque résiduel (INV7) : l'enfant du bac à sable (uid 1500) peut créer des espaces de noms utilisateur après une évasion.
    expect(section('## Modèle de privilèges')).toMatch(/### Risque résiduel : espaces de noms utilisateur/);
    // Le README du bac à sable ne prétend plus que seccomp refuse unshare.
    const readme = readFileSync(join(runtimeDir, 'apps/worker/src/sandbox/README.md'), 'utf8');
    expect(readme).not.toMatch(/seccomp refuse `unshare`/);
    expect(readme).toContain('docs/deploiement.md#risque-résiduel--espaces-de-noms-utilisateur');
    // Condition d'hôte : la CI lève la restriction AppArmor des espaces de noms utilisateur (Ubuntu 23.10+) ; le profil
    // seccomp seul n'est donc pas vérifié sur un hôte Ubuntu aux réglages par défaut, et le guide Compose le dit.
    const composeGuide = readFileSync(join(runtimeDir, 'apps/docs/content/guides/docker-compose.md'), 'utf8');
    expect(composeGuide).toMatch(/kernel\.apparmor_restrict_unprivileged_userns[\s\S]{0,400}non vérifié/);
    const composeRow = guide.split('\n').find((l) => l.startsWith('| Docker Compose |'));
    expect(composeRow?.split(' | ').at(-1)).toContain('apparmor_restrict_unprivileged_userns');
  });

  test('variables du conteneur : catalogue seulement ; secrets obligatoires (`:?`) ; image par RUNTIME_IMAGE, épinglée', () => {
    for (const name of ['migrate', 'server', 'worker']) {
      for (const key of Object.keys(doc.services[name]!.environment!)) expect(catalog.has(key) || COMPOSE_ONLY.has(key), `${name}.${key}`).toBe(true);
    }
    expect(doc.services['server']!.environment!['MASTER_KEY']).toMatch(/^\$\{MASTER_KEY:\?/);
    expect(doc.services['worker']!.environment!['MASTER_KEY']).toMatch(/^\$\{MASTER_KEY:\?/);
    expect(doc.services['server']!.environment!['PUBLIC_URL']).toMatch(/^\$\{PUBLIC_URL:\?/);
    expect(doc.services['postgres']!.environment!['POSTGRES_PASSWORD']).toMatch(/^\$\{POSTGRES_PASSWORD:\?/);
    expect(raw).not.toMatch(/MASTER_KEY: [A-Za-z0-9+/]{43}=/);
  });
});

describe('modèle Railway (best-effort) : description du modèle à saisir', () => {
  type Tpl = { image: string; services: { name: string; preDeployCommand?: string; healthcheckPath?: string; variables?: Record<string, string> }[] };
  const doc = yaml<Tpl>('railway/template.yaml');
  const service = (name: string) => doc.services.find((s) => s.name === name)!;
  const ALPHABET = /\$\{\{secret\((\d+), "([^"]*)"\)\}\}/g;
  /** Évalue les `secret(n, alphabet)` de Railway ; les autres références (`${{Postgres.…}}`) restent telles quelles. */
  const expand = (expression: string) =>
    expression.replace(ALPHABET, (_m, n: string, alphabet: string) => Array.from({ length: Number(n) }, () => alphabet[randomBytes(1)[0]! % alphabet.length]).join(''));

  test('server : migration en pré-déploiement, sonde /api/ready ; worker : mode worker, sans sonde ni migration', () => {
    expect(service('server').preDeployCommand).toBe('runtime migrate');
    expect(service('server').healthcheckPath).toBe('/api/ready');
    expect(service('server').variables!['RUNTIME_MODE']).toBe('server');
    expect(service('worker').variables!['RUNTIME_MODE']).toBe('worker');
    expect(service('worker').preDeployCommand).toBeUndefined();
    expect(service('worker').healthcheckPath).toBeUndefined();
    for (const name of ['server', 'worker']) expect(service(name).variables!['DATABASE_URL']).toBe('${{Postgres.DATABASE_URL}}');
  });

  test('le worker lit la MASTER_KEY du serveur (jamais sa propre clé) ; seules des variables du catalogue', () => {
    expect(service('worker').variables!['MASTER_KEY']).toBe('${{server.MASTER_KEY}}');
    for (const name of ['server', 'worker']) for (const key of Object.keys(service(name).variables!)) expect(catalog.has(key), key).toBe(true);
  });

  test('MASTER_KEY générée par secret() : valide à CHAQUE génération ; la forme naïve `secret(43)` + `=` en refuse la plupart', () => {
    const expression = service('server').variables!['MASTER_KEY']!;
    for (let i = 0; i < 1500; i += 1) {
      const key = expand(expression);
      expect(key).toHaveLength(44);
      MasterKey.parse(key); // lève si invalide
    }
    const naive = '${{secret(43, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/")}}=';
    let refused = 0;
    for (let i = 0; i < 400; i += 1) {
      try {
        MasterKey.parse(expand(naive));
      } catch {
        refused += 1;
      }
    }
    expect(refused / 400).toBeGreaterThan(0.5); // ~75 % : c'est pourquoi le dernier caractère est contraint
  });

  test('jeton d’amorçage généré : 32 caractères au moins', () => {
    expect(expand(service('server').variables!['ADMIN_BOOTSTRAP_TOKEN']!).length).toBeGreaterThanOrEqual(32);
  });
});

describe('Heroku (best-effort) : heroku.yml, deux Dockerfile, app.json', () => {
  const manifest = yaml<{ setup: { addons: { plan: string; as: string }[]; config: Record<string, string> }; build: { docker: Record<string, string> }; release: { image: string; command: string[] }; run?: Record<string, string> }>('heroku/heroku.yml');
  const appJson = JSON.parse(text('heroku/app.json')) as { stack: string; env: Record<string, { value?: string; generator?: string; required?: boolean }>; addons: { plan: string }[]; formation: Record<string, { size: string }> };

  test('web et worker construits depuis des Dockerfile voisins ; release phase = `runtime migrate` sur l’image web', () => {
    expect(manifest.build.docker).toEqual({ web: 'Dockerfile.web', worker: 'Dockerfile.worker' });
    for (const file of Object.values(manifest.build.docker)) expect(existsSync(join(deployDir, 'heroku', file)), file).toBe(true);
    expect(manifest.release).toEqual({ image: 'web', command: ['runtime migrate'] });
    expect(manifest.setup.addons).toEqual([{ plan: 'heroku-postgresql:essential-0', as: 'DATABASE' }]);
  });

  test('run explicite : web et worker démarrent le point d’entrée de l’image (l’image de base n’a pas de CMD)', () => {
    const entrypoint = readFileSync(join(deployDir, 'Dockerfile'), 'utf8').match(/^ENTRYPOINT \[.*"([^"]+entrypoint\.sh)"\]$/m)?.[1];
    expect(entrypoint).toBe('/usr/local/bin/entrypoint.sh');
    expect(manifest.run).toEqual({ web: entrypoint, worker: entrypoint });
  });

  test('ce run fonctionne que Heroku garde l’ENTRYPOINT (argument unique, ou passé par /bin/sh -c) ou non : on arrive au choix du rôle', () => {
    // Hors image, le chemin du point d'entrée est celui du dépôt ; RUNTIME_MODE invalide prouve que le choix du rôle est atteint.
    const script = join(deployDir, 'entrypoint.sh');
    const env = { PATH: process.env['PATH'] ?? '', RUNTIME_MODE: 'zz_test_mode' };
    for (const args of [[script, script], [script, '/bin/sh', '-c', script], [script]]) {
      const res = spawnSync('bash', args, { encoding: 'utf8', env, timeout: 20_000 });
      expect(res.status, args.join(' ')).toBe(64);
      expect(res.stderr).toMatch(/RUNTIME_MODE invalide/);
    }
  });

  test('chaque Dockerfile : FROM épinglé SANS commentaire sur la ligne, mode correct (un `#` en fin de ligne FROM casserait le build)', () => {
    for (const [file, mode] of [['Dockerfile.web', 'server'], ['Dockerfile.worker', 'worker']] as const) {
      const dockerfile = text(`heroku/${file}`);
      expect(dockerfile.match(/^FROM .*$/gm)).toHaveLength(1);
      expect(dockerfile).toMatch(/^FROM \S+$/m);
      expect(dockerfile).toMatch(new RegExp(`^ENV RUNTIME_MODE=${mode}$`, 'm'));
    }
  });

  test('aucun secret dans le dépôt : heroku.yml ne pose que des réglages ; app.json demande MASTER_KEY, ne la fixe pas', () => {
    expect(Object.keys(manifest.setup.config).sort()).toEqual(['PGSSLMODE', 'TRUST_PROXY']);
    expect(appJson.stack).toBe('container');
    expect(appJson.env['MASTER_KEY']).toMatchObject({ required: true });
    expect(appJson.env['MASTER_KEY']!.value).toBeUndefined();
    expect(appJson.env['MASTER_KEY']!.generator).toBeUndefined(); // le générateur `secret` de Heroku ne produit pas du base64 de 32 octets
    for (const key of Object.keys(appJson.env)) expect(catalog.has(key) || PLATFORM_ONLY.has(key), key).toBe(true);
    expect(appJson.formation['worker']!.size).toMatch(/^performance-/);
  });
});

describe('aucun secret dans les modèles', () => {
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));

  test('ni clé maîtresse canonique, ni jeton d’API, ni clé privée dans deploy/', () => {
    for (const file of [...files(deployDir), RENDER_YAML]) {
      const content = readFileSync(file, 'utf8');
      expect(content, file).not.toMatch(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=(?![A-Za-z0-9+/=])/);
      expect(content, file).not.toMatch(/sk-[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}/);
    }
  });

  test('toutes les variables du catalogue marquées obligatoires sont fournies par chaque cible (ou générées)', () => {
    const required = ENV_CATALOG.filter((v) => v.required === true).map((v) => v.name);
    expect(required.sort()).toEqual(['DATABASE_URL', 'MASTER_KEY', 'PUBLIC_URL']);
    const render = yaml<{ envVarGroups: { envVars: { key: string }[] }[]; services: { type: string; envVars: { key?: string }[] }[] }>('render.yaml');
    const web = new Set([...render.services.find((s) => s.type === 'web')!.envVars.map((e) => e.key), ...render.envVarGroups.flatMap((g) => g.envVars.map((e) => e.key))]);
    for (const name of required) expect(web.has(name), `render.yaml : ${name}`).toBe(true);
  });
});
