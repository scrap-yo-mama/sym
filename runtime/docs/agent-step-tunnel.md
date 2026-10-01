# Contrat `agent_step` du tunnel

> Tâche 0.6b. Source : `cdc/scrapyomama-runtime/07-specs-extension-tunnel.md` §3, §5 et §8 ; ADR 0001 (moteur agentique).
> Ce document fixe ce que l'extension sait exécuter pour un agent, ce que le serveur peut lui demander, et ce que le tunnel ne sert pas.

## Ce que le tunnel sert pour un agent

Un agent (stratégie E6, et E5 pilotée pas à pas) agit sur la page de l'utilisateur par **une action à la fois**, parmi cinq : `navigate`, `click`, `type`, `scroll`, `read`. Chaque réponse porte l'arbre d'accessibilité tronqué de la page et un `snapshot_id`. Une action vise un `ref` **d'un `snapshot_id` donné**.

| Pièce | Où | Rôle |
|---|---|---|
| Types et validation du fil (`agentStepToWire`, `parseAgentStepArgs`, `parseAgentStepWireResult`) | `packages/core/src/agent/step-wire.ts` | Jeu fermé, partagé par le serveur et l'extension |
| Suivi des instantanés et exécuteur (`StepSnapshotTracker`, `AgentStepExecutor`) | `packages/core/src/agent/step-session.ts` | Règle de fraîcheur, refus typés, arrêt sur défi ; sans Node, utilisable dans le service worker |
| Client du tunnel (`TunnelStepChannel`, `runAgentInTunnel`, `assertTunnelEngine`) | `packages/agent/src/tunnel-channel.ts` | Seul code serveur qui parle `agent_step` à l'extension ; refuse les moteurs tiers |
| Pilote CDP et passerelle WSS | tâches 2.6 et 2.7 | Branchent l'exécuteur sur `chrome.debugger` et le client sur la WSS ; hors de cette tâche |

## Règle de fraîcheur (`stale_ref`)

Un `ref` n'est valable que si **les deux** conditions tiennent au moment de l'action :

1. le `snapshot_id` de l'action est celui du dernier instantané émis ;
2. la page n'a pas changé depuis (même URL, même arbre : le `snapshot_id` est lié à ce contenu).

Sinon l'extension répond `stale_ref` avec **le nouvel instantané** et **n'exécute rien**. Un `ref` inconnu dans l'arbre courant est traité de la même façon. Comme la page peut changer entre la vérification et l'action, le pilote reçoit aussi le rôle et le nom de l'élément attendu et refuse (`stale_ref`) si le `ref` ne désigne plus cet élément : une action ne part jamais sur un autre élément que celui que le modèle a vu.

## Fil

Commande (`cmd: "agent_step"`, enveloppe de 07 §8) : `args = { action, ref?, snapshot_id?, url?, text?, direction? }`. Champs par action :

| Action | Champs |
|---|---|
| `navigate` | `url` (http ou https) |
| `click` | `ref`, `snapshot_id` |
| `type` | `ref`, `snapshot_id`, `text` (4 096 caractères au plus) |
| `scroll` | `snapshot_id`, `direction` (`up` ou `down`) |
| `read` | `snapshot_id` facultatif |

Tout autre champ, toute autre action, tout `ref` ou identifiant hors forme est refusé par `method_not_allowed`, sans rien évaluer. Aucune chaîne venue du serveur n'est exécutée comme code.

Réponse (corps réassemblé) : `{ ok, snapshot_id, error, snapshot: { snapshot_id, url, tree, truncated } | null }`. Un succès porte un instantané ; un `stale_ref` porte le nouvel instantané ; une réponse qui viole ce contrat est une erreur de protocole côté serveur, jamais un succès.

| Code du fil | Code du canal serveur | Cas |
|---|---|---|
| `stale_ref` | `stale_ref` | Instantané périmé ou `ref` inconnu |
| `method_not_allowed` | `method_not_allowed` | Commande hors du jeu fermé |
| `write_action_blocked` | `write_action_not_allowed` | Clic d'écriture sans `allow_write_actions` |
| `challenge_in_tunnel` | `challenge_detected` | Défi détecté : l'exécuteur ne laisse plus passer aucune commande, le client n'en émet plus |
| `domain_not_allowed` | `domain_not_allowed` | Navigation hors domaines connectés ou adresse refusée |
| `timeout` | `timeout` | Action non terminée à temps |

## Ce que le tunnel ne sert pas : E6 limité au serveur

L'ADR 0001 retient **Stagehand 3.7.3** comme moteur agentique. Stagehand pilote Chromium par son propre client CDP : il n'est **pas** compatible `agent_step`, et 07 §3 interdit aux moteurs tiers de passer par le tunnel (`assert_third_party_engine_not_via_tunnel`).

**Conséquence : avec le moteur retenu, E6 est limité au serveur.** Le garde existe (`assertTunnelEngine`, appelé par `runAgentInTunnel`) : une exécution d'un moteur tiers en tunnel est refusée avant tout run (`ThirdPartyEngineNotViaTunnelError`, code `third_party_engine_not_via_tunnel`) et aucune commande n'atteint l'extension. Son branchement dans l'ordonnancement (choix de la stratégie selon le mode réseau) relève des tâches 2.4 et 2.7. En tunnel, restent servis E1 à E5 (les scripts E5 sont compilés puis rejoués sans agent).

Le client `agent_step` du paquet et la boucle maison (compatible par construction) existent et sont testés de bout en bout, mais la boucle maison n'est pas le moteur retenu. La réhabiliter pour servir E6 en tunnel exige un nouvel ADR et un nouveau spike (ADR 0001, section Conséquences), pas un ajustement de ce contrat.

L'interface (tâche 3.x) et la tâche 2.4 doivent donc présenter E6 comme **« serveur seulement »** et ne jamais proposer E6 pour un site en mode tunnel.
