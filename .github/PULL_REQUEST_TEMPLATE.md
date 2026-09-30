## Résumé

<!-- Quoi et pourquoi, en quelques lignes. Lien vers l'issue si elle existe. -->

## Liste de contrôle

- [ ] Un correctif commence par un test rouge : deux commits (test qui échoue, puis correctif).
- [ ] `pnpm test:fast` et `pnpm -r build` sont verts en local.
- [ ] Chaque commit porte `Signed-off-by` (DCO, `git commit -s`, voir `runtime/DCO.md`).
- [ ] Cœur AGPL : je comprends que le CLA s'applique (`runtime/CLA.md`, texte provisoire, bot non activé). Paquets MIT : DCO seul.
- [ ] Nouveaux fichiers sources : en-tête `SPDX-License-Identifier` (`pnpm spdx:add`).
- [ ] Aucune dépendance nouvelle hors de la stack du CDC sans accord ; versions exactes via le catalogue.
- [ ] Aucun site réel ni LLM réel dans les tests ; aucun fichier `.py` ni `.ipynb`.
- [ ] Cette contribution ne relève pas de X1 à X6 (`runtime/docs/hors-perimetre.md`) : elle ne résout pas de défi, ne masque pas l'identité du navigateur, ne franchit pas de protection, ne change pas d'IP après un refus, n'utilise pas de multi-comptes.
