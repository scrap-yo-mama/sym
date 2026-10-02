---
name: browser-ci
description: Lance la CI locale du module SYM Browser sous le verrou de test partagé, puis la suite complète du workspace si la tâche touche un fichier partagé. À utiliser avant chaque commit du module ("CI locale", "lance les tests du module", "vérifie avant de committer").
---

# CI locale du module SYM Browser

La CI locale rejoue le job `browser` de `.github/workflows/ci.yml` : installation gelée, build, types, lint (frontière comprise), tests du module et de `@sym/contracts`, en-têtes SPDX, puis image Docker lancée avec seccomp, `no-new-privileges` et `--cap-drop ALL` (uid ≠ 0, `Seccomp: 2`, aucune capacité, aucun binaire setuid).

## Procédure

1. Prends un verrou de test (partagé avec l'orchestrateur de SYM). Essaie `mkdir /tmp/claude-501/scrapyomama-test.lock.1`, sinon `.lock.2` s'il n'existe pas. Un verrou qui contient un fichier `guard` n'est pas à toi. Tous pris : attends (30 s entre deux essais, 40 min au plus), puis signale l'attente.
2. Depuis `runtime/` :
   ```bash
   pnpm --filter @sym-browser/module ci:local            # complet, image comprise
   pnpm --filter @sym-browser/module ci:local --skip-image   # sans Docker (dis-le dans ton rapport)
   ```
3. Si ta tâche modifie un fichier partagé (`pnpm-workspace.yaml`, lockfile, `.npmrc`, `.node-version`, `eslint.config.mjs`, `ci.yml`, `scripts/spdx-headers.ts`, `scripts/check-licenses.ts`, `packages/contracts`, `packages/ui`) : lance aussi `pnpm ci:local` (suite complète de SYM).
4. Supprime ton verrou (`rmdir`), même en cas d'échec.
5. Rapporte : commande, dernière ligne de sortie, étape en échec le cas échéant. Ne prétends jamais qu'une étape a tourné si elle a été sautée.
