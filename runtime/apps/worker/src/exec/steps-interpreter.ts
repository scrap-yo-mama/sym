// SPDX-License-Identifier: AGPL-3.0-only
// Interpréteur des stratégies `steps` (E5, tâche 2.13, 19 §4) : code FIXE du dépôt (jamais généré), exécuté dans le bac à
// sable de 1.5 (INV7) comme un script E3. Il ne reçoit que le plan des étapes (opérations) et l'arrêt éventuel
// (`input.steps`, `input.stop_before`) ; chaque action passe par `ctx.steps.run(action, index)`, que l'hôte contrôle
// contre sa propre copie de la stratégie (steps-host.ts). L'enregistrement extrait est émis par `ctx.emit` et validé
// contre `output_schema` par l'appelant (INV1). Aucun accès direct à la page, au réseau ni aux entrées du run.
export const STEPS_INTERPRETER_SOURCE = String.raw`
const plan = input.steps;
const stopBefore = input.stop_before;
for (let i = 0; i < plan.length; i += 1) {
  if (stopBefore === i) {
    await ctx.steps.run('pause', i);
    return { paused: i };
  }
  const op = plan[i].op;
  await ctx.steps.run('begin', i);
  const out = await ctx.steps.run(op, i);
  if (op === 'extract') ctx.emit(out.record);
  await ctx.steps.run('end', i);
}
return { done: plan.length };
`;
