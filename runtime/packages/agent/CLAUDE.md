# CLAUDE.md : `runtime/packages/agent` (`@runtime/agent`)

## Rôle et module

Moteur agentique serveur : boucle maison (`HomeLoopEngine`), moteur Stagehand 3.7.3 en mode `dom` local seulement
(ADR 0001, `runtime/docs/adr/0001-agent-engine.md`), canaux `agent_step` Playwright et tunnel, extraction E4, interpréteur E5
(`hybrid`) et rôle `investigate`. Il appartient au module **Brain** (`docs/modules.md` du dépôt de travail, non publié) : il implémente l'interface `AgentEngine`
définie dans `@runtime/core`.

## Ce qu'il expose

Un seul point d'entrée, `exports["."]` = `dist/index.js` (types `dist/index.d.ts`), construit par `tsc -b`. `src/index.ts` exporte :

- Boucle et moteurs : `HomeLoopEngine`, `StagehandEngine`, `STAGEHAND_VERSION`, `jsonSchemaToZod`.
- Canaux : `PlaywrightStepChannel`, `installDomainGuard`, `newAgentContext`, `TunnelStepChannel`, `runAgentInTunnel`,
  `assertTunnelEngine`, `ThirdPartyEngineNotViaTunnelError`.
- Garde-fous : `assertStagehandLocalOnly`, `STAGEHAND_EXCLUDED_TOOLS`, `toolsOutsideClosedList`, `AgentToolsetNotClosedError`.
- Extraction et enquête : `extractRecordsWithLlm`, `runHybridSteps`, `proposeInvestigation`, `installSemanticRecorder`,
  `sanitizeModelPrompt`, versions de prompts (`*PromptVersion`).

Les cassettes d'enregistrement (`cassettes/`) servent aux tests de contrat, jamais à un appel LLM réel.

## Ce qu'il peut importer

- `@runtime/core` et `@runtime/core/investigation` (types, DSL, interface `AgentEngine`, trames `agent_step`).
- `@runtime/llm` et `@runtime/llm/testing` (client LLM, faux fournisseur).
- Bibliothèques de `package.json` : `@browserbasehq/stagehand`, `playwright-core`, `zod`.
- Il n'importe PAS `@runtime/db`, ni aucune application (`@runtime/server`, `@runtime/worker`, `@runtime/cli`, `@runtime/web`,
  `@runtime/extension`) : la persistance et l'ordonnancement restent dans le worker (`dependency-cruiser` : `brain-pas-runner`).

## Tests (scripts de `package.json`)

- `pnpm --filter @runtime/agent test` : `vitest run` (tests unitaires et de contrat du paquet).
- `pnpm --filter @runtime/agent build` : `tsc -b` (nécessaire avant que d'autres paquets importent `dist/`).
- Depuis `runtime/` : `pnpm test:fast` (projets unit et contract), `pnpm typecheck`, `pnpm lint`.

Pas de script `typecheck` propre : la vérification de types passe par `tsc -b` et par `pnpm typecheck` de la racine.

## Invariants applicables

Tests nommés présents dans ce dossier (table : `runtime/tests/invariants.json`) :

- `assert_agent_toolset_closed` : liste d'outils fermée, aucun outil Stagehand hors liste.
- `assert_stagehand_local_only` : Stagehand tourne en local seulement (jamais d'hébergeur ni de clé cloud).
- `assert_third_party_engine_not_via_tunnel` et `assert_agent_step_stale_ref` : moteur tiers refusé en tunnel ; un `ref` périmé est
  une erreur typée, jamais une action sur un autre élément.
- `assert_prompt_injection_no_trap_request` : une page piégée n'obtient ni requête ni outil (extraction E4).
- `assert_llm_redaction`, `assert_llm_prompts_not_logged` : aucun secret ni prompt dans les journaux.
- `assert_e4_irregular_html` : l'extraction E4 tient sur du HTML irrégulier.

E6 (`agent`) est limité au serveur : jamais en tunnel.
