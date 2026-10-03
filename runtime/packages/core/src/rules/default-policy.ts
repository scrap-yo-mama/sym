// SPDX-License-Identifier: AGPL-3.0-only
// Politique par défaut `escalade-par-defaut.md` (tâche 2.10, 18 §4.2) : transcription fidèle de 04 §3.3, livrée dans
// `templates/rules/rules/` et installée par la migration 0019 comme règle PARTAGÉE D'INSTANCE (`applies_to: ["*"]`,
// origine `seed`) ; version 2 posée par la migration 0021 (D-91 : arrêts sans `robots_disallowed`) si l'admin n'a pas
// modifié la version 1. Modifiable par l'admin seul, en console. Le template, cette constante, la migration et
// l'empreinte sont tenus identiques par un test. Une référence à CETTE version (empreinte du template) ne réordonne rien : seul l'ordre de
// 04 §3.3 en sort (assert_cheapest_first_logged inchangé).
export const DEFAULT_POLICY_NAME = 'escalade-par-defaut';

export const DEFAULT_POLICY_MARKDOWN = "---\nname: escalade-par-defaut\ndescription: Politique par défaut « du moins cher au plus cher » (04 §3.3) ; ordre, élagages et arrêts exécutés par le code.\nkind: rule\napplies_to: [\"*\"]\n---\n# Escalade par défaut : du moins cher au plus cher\n\nTranscription de 04 §3.3, sans heuristique ajoutée. Le code calcule l'ensemble des couples (E, N) autorisés et leur\ncoût estimé ; il exécute lui-même l'ordre, les élagages et les arrêts ci-dessous, quoi que dise ce fichier. Ce texte les\ndécrit pour que l'agent les connaisse.\n\n## Ordre d'essai\n\nCouples autorisés triés par `est_cost_usd` croissant, puis par E (E1 à E6), puis par N (N1 à N3).\n\n## Élagage après un échec (classe du classifieur)\n\n- `network` : sauter les couples restants avec le même N.\n- `extraction` : sauter les couples restants avec le même E.\n\n## Arrêts\n\n- `blocked_by_protection`, `forbidden` : arrêt de tout essai, statut `bloquee`.\n- `auth_required`, `payment_required` : la main revient à l'utilisateur, statut `action_requise`.\n\n## Sélection\n\nLa stratégie retenue est la moins chère conforme parmi les couples essayés. Un couple moins cher, ni essayé ni exclu par\nune règle, est essayé avant de retenir.\n";

export const DEFAULT_POLICY_SHA256 = 'd71314ffdfdef7c049424266fdba6e5e50fe785861ceec173a85bac4c1151107';
