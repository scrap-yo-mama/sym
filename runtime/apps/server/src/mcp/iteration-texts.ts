// SPDX-License-Identifier: AGPL-3.0-only
// Textes de l'itération par MCP (tâche 3.14, 07 § 4, voix de 08) : phrases localisées (`en`, `fr`) du brouillon, du test, de la
// promotion, du retour et des refus. Même règle que le récit : seuls des codes, des comptes, des coûts et des noms de la liste
// fermée y entrent (jamais le texte d'un retour, d'un item ou d'un site). Signature « SYM 👻 : » sur un succès, rien sur un
// refus (08 § 2). Aucun verbe de contournement (assert_ui_strings_no_forbidden_words).
import type { DiffSummaryParts, SchemaChange } from '@runtime/core';
import { fmtUsd, type McpLocale } from './texts.js';

const sig = (locale: McpLocale): string => (locale === 'fr' ? 'SYM 👻 :' : 'SYM 👻:');
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const COUNT = (locale: McpLocale, n: number, one: string, many: string): string => `${n} ${plural(n, one, many)}${locale === 'fr' ? '' : ''}`;

/** Changements du schéma, en mots : « 1 champ ajouté, 1 renommé ou retiré (changement cassant) ». */
export function schemaChangeText(locale: McpLocale, changes: readonly SchemaChange[]): string {
  const added = changes.filter((c) => c.kind === 'field_added').length;
  const removed = changes.filter((c) => c.kind === 'field_removed').length;
  const retyped = changes.filter((c) => c.kind === 'type_changed' || c.kind === 'required_removed' || c.kind === 'enum_changed' || c.kind === 'constraint_changed' || c.kind === 'unknown_keyword').length;
  const breaking = changes.some((c) => c.level === 'major');
  const parts: string[] = [];
  if (locale === 'fr') {
    if (added > 0) parts.push(COUNT(locale, added, 'champ ajouté', 'champs ajoutés'));
    if (removed > 0) parts.push(COUNT(locale, removed, 'champ retiré ou renommé', 'champs retirés ou renommés'));
    if (retyped > 0) parts.push(COUNT(locale, retyped, 'règle modifiée', 'règles modifiées'));
    return parts.length === 0 ? '' : `${parts.join(', ')}${breaking ? ' (changement cassant)' : ''}.`;
  }
  if (added > 0) parts.push(COUNT(locale, added, 'field added', 'fields added'));
  if (removed > 0) parts.push(COUNT(locale, removed, 'field removed or renamed', 'fields removed or renamed'));
  if (retyped > 0) parts.push(COUNT(locale, retyped, 'rule changed', 'rules changed'));
  return parts.length === 0 ? '' : `${parts.join(', ')}${breaking ? ' (breaking change)' : ''}.`;
}

export type RefineText = { changes: readonly SchemaChange[]; costUsd: number | null; feedbackOnly: boolean; dryRun?: boolean };

/** Brouillon créé (07 § 4) : ce qui tourne ne change pas, ce qui change, l'estimation, la prochaine étape. */
export function refinedText(locale: McpLocale, t: RefineText): string {
  const change = schemaChangeText(locale, t.changes);
  const cost = fmtUsd(t.costUsd, locale);
  if (locale === 'fr') {
    if (t.dryRun === true) return `Estimation : ~${cost}. Rien n’est créé : appelle de nouveau sans dry_run pour préparer le brouillon.`;
    return `${sig(locale)} Brouillon prêt. Ce qui tourne ne change pas. ${change === '' ? 'Ton retour est noté dans le brouillon.' : change} Estimation : ~${cost}. Prochaine étape : le tester.`.replace(/  +/g, ' ');
  }
  if (t.dryRun === true) return `Estimate: ~${cost}. Nothing is created: call again without dry_run to prepare the draft.`;
  return `${sig(locale)} Draft ready. What runs does not change. ${change === '' ? 'Your feedback is saved in the draft.' : change} Estimate: ~${cost}. Next step: test it.`.replace(/  +/g, ' ');
}

/** Phrase du diff par gabarit déterministe (r3 R10) : un code et des nombres. */
export function diffSentence(locale: McpLocale, parts: DiffSummaryParts): string {
  const p = parts.params;
  const n = (k: string): number => p[k] ?? 0;
  if (locale === 'fr') {
    if (parts.code === 'diff_none') return `${n('total')} éléments, aucun changement par rapport à la version en service`;
    if (parts.code === 'diff_content') return `${n('total')} éléments, ${n('added')} nouveaux, ${n('removed')} disparus`;
    return `${n('total')} éléments : ${n('changed')} modifiés, ${n('added')} ajoutés, ${n('removed')} retirés${n('filled') > 0 ? `, ${n('filled')} champs remplis` : ''}${n('dropped') > 0 ? `, ${n('dropped')} champs vidés` : ''}`;
  }
  if (parts.code === 'diff_none') return `${n('total')} items, no change from the version in service`;
  if (parts.code === 'diff_content') return `${n('total')} items, ${n('added')} new, ${n('removed')} gone`;
  return `${n('total')} items: ${n('changed')} changed, ${n('added')} added, ${n('removed')} removed${n('filled') > 0 ? `, ${n('filled')} fields filled` : ''}${n('dropped') > 0 ? `, ${n('dropped')} fields emptied` : ''}`;
}

export type TestedText = { ok: boolean; summary: DiffSummaryParts | null; costUsd: number | null; items: number; rejected: number; failureCode: string | null; llmFree: boolean };

/** Résultat d'un test : le diff en une phrase, le coût, et ce qu'il reste à faire. */
export function testedText(locale: McpLocale, t: TestedText): string {
  const cost = fmtUsd(t.costUsd, locale);
  if (!t.ok) {
    if (locale === 'fr') return `Le test n’a pas abouti${t.failureCode === null ? '' : ` (${t.failureCode})`}${t.rejected > 0 ? ` : ${t.rejected} éléments ne respectent pas le schéma du brouillon` : ''}. Affine le brouillon puis reteste. Coût : ${cost}.`;
    return `The test did not succeed${t.failureCode === null ? '' : ` (${t.failureCode})`}${t.rejected > 0 ? `: ${t.rejected} items do not match the draft schema` : ''}. Refine the draft, then test again. Cost: ${cost}.`;
  }
  const sentence = t.summary === null ? (locale === 'fr' ? `${t.items} éléments` : `${t.items} items`) : diffSentence(locale, t.summary);
  if (locale === 'fr') return `${sig(locale)} Test fait : ${sentence}. Coût : ${cost}${t.llmFree ? ', sans appel au modèle' : ''}. Prochaine étape : promouvoir, si tu es d’accord avec ce diff.`;
  return `${sig(locale)} Test done: ${sentence}. Cost: ${cost}${t.llmFree ? ', no model call' : ''}. Next step: promote, if you agree with this diff.`;
}

export const promotedText = (locale: McpLocale, version: number): string =>
  locale === 'fr' ? `${sig(locale)} Version ${version} en service. Tu peux revenir en arrière à tout moment.` : `${sig(locale)} Version ${version} is in service. You can go back at any time.`;

export const revertedText = (locale: McpLocale, version: number, draftKept: boolean): string =>
  locale === 'fr'
    ? `${sig(locale)} Version ${version} remise en service.${draftKept ? ' Le brouillon reste disponible.' : ''}`
    : `${sig(locale)} Version ${version} is back in service.${draftKept ? ' The draft is still available.' : ''}`;

export const discardedText = (locale: McpLocale, version: number): string =>
  locale === 'fr' ? `Brouillon ${version} jeté. La version en service n’a pas changé.` : `Draft ${version} discarded. The version in service did not change.`;

export type ResumeText = { slug: string; current: number | null; draft: number | null; tested: boolean; stale: boolean; blocked: boolean };

/** Reprise d'une itération dans une autre conversation : où elle en est, en une phrase. */
export function resumeText(locale: McpLocale, t: ResumeText): string {
  if (locale === 'fr') {
    if (t.draft === null) return `API ${t.slug} : version ${t.current ?? '?'} en service, aucun brouillon. Pour la modifier, commence par affiner.`;
    return `API ${t.slug} : version ${t.current ?? '?'} en service, brouillon ${t.draft} ${t.stale ? 'périmé : reteste-le' : t.tested ? 'testé' : 'à tester'}.`;
  }
  if (t.draft === null) return `API ${t.slug}: version ${t.current ?? '?'} in service, no draft. To change it, start by refining.`;
  return `API ${t.slug}: version ${t.current ?? '?'} in service, draft ${t.draft} ${t.stale ? 'out of date: test it again' : t.tested ? 'tested' : 'to test'}.`;
}

export type IterationErrorText = Record<string, { en: string; fr: string }>;

/** Messages des refus de l'itération : cause d'abord, action ensuite, deux phrases au plus (08 § 4). Sans signature. */
export const ITERATION_MESSAGES: IterationErrorText = {
  api_blocked: { en: 'This API is stopped. Fix that first: an API blocked by the site or waiting for an action is neither refined nor tested.', fr: 'Cette API est arrêtée. Règle d’abord ce point : une API bloquée par le site ou qui attend une action ne s’affine ni ne se teste.' },
  api_busy: { en: 'An investigation or a repair is running on this API. Wait for it to finish, then call again.', fr: 'Une enquête ou une réparation est en cours sur cette API. Attends sa fin, puis recommence.' },
  refine_in_progress: { en: 'A refinement is already running for this API. Wait for it to finish, then call again.', fr: 'Un affinage est déjà en cours pour cette API. Attends sa fin, puis recommence.' },
  nothing_to_refine: { en: 'Nothing to refine: give a feedback or a new output schema.', fr: 'Rien à affiner : donne un retour ou un nouveau schéma de sortie.' },
  invalid_schema: { en: 'The output schema is not accepted (JSON Schema 2020-12, no remote reference). Fix it, then call again.', fr: 'Le schéma de sortie n’est pas accepté (JSON Schema 2020-12, aucune référence distante). Corrige-le puis recommence.' },
  no_current_version: { en: 'This API has no validated version yet. Wait for its investigation to finish.', fr: 'Cette API n’a pas encore de version validée. Attends la fin de son enquête.' },
  no_draft: { en: 'There is no draft for this API. Refine it first.', fr: 'Cette API n’a pas de brouillon. Commence par l’affiner.' },
  base_stale: { en: 'The version in service changed since your draft. Test it again before promoting it.', fr: 'La version en service a changé depuis ton brouillon. Reteste-le avant de le promouvoir.' },
  not_tested: { en: 'The draft was not tested yet. Test it, then promote it.', fr: 'Le brouillon n’a pas encore été testé. Teste-le, puis promeus-le.' },
  diff_hash_mismatch: { en: 'The diff you saw is out of date. Test the draft again and promote with the new diff_hash.', fr: 'Le diff que tu as vu est périmé. Reteste le brouillon et promeus avec le nouveau diff_hash.' },
  not_conform: { en: 'The draft output does not match its schema. Refine it, then test again.', fr: 'La sortie du brouillon ne respecte pas son schéma. Affine-le puis reteste.' },
  too_few_samples: { en: 'The test returned fewer than 3 valid items. Test again with an input that returns more.', fr: 'Le test a rendu moins de 3 éléments valides. Reteste avec une entrée qui en rend plus.' },
  replay_not_llm_free: { en: 'The draft replay called a model. Only a replay without a model call is promoted.', fr: 'Le rejeu du brouillon a appelé un modèle. Seul un rejeu sans appel au modèle est promu.' },
  cost_increase_requires_accept: { en: 'The draft costs more per run than the version in service. Confirm with accept_cost_increase to promote it.', fr: 'Le brouillon coûte plus cher par run que la version en service. Confirme avec accept_cost_increase pour le promouvoir.' },
  cost_above_cap: { en: 'The estimate is above the cap of this API. Lower the scope or raise the cap in the console.', fr: 'L’estimation dépasse le plafond de cette API. Réduis la portée ou relève le plafond dans la console.' },
  cost_confirmation_required: { en: 'The estimate is above the confirmation threshold. Call again with accept_cost: true to accept it.', fr: 'L’estimation dépasse le seuil de confirmation. Recommence avec accept_cost: true pour l’accepter.' },
  version_not_revertable: { en: 'Only a version that was in service can be restored.', fr: 'Seule une version qui a été en service peut être rétablie.' },
  already_current: { en: 'This version is already in service.', fr: 'Cette version est déjà en service.' },
  no_previous_version: { en: 'There is no earlier version to go back to.', fr: 'Il n’y a pas de version antérieure à rétablir.' },
  status_not_promotable: { en: 'The status of this API does not allow this change right now.', fr: 'Le statut de cette API ne permet pas ce changement pour l’instant.' },
  breaking_change_requires_ack: { en: 'This change breaks existing uses. Confirm it in the console, with the box that acknowledges it.', fr: 'Ce changement casse des usages existants. Confirme-le dans la console, avec la case qui en prend acte.' },
  human_confirmation_required: { en: 'Promoting this draft is a human decision. Open the console, read the diff, then confirm there.', fr: 'Promouvoir ce brouillon est une décision humaine. Ouvre la console, lis le diff, puis confirme là-bas.' },
  promotion_declined: { en: 'The promotion was declined: nothing changed, the version in service is the same.', fr: 'La promotion a été refusée : rien n’a changé, la version en service est la même.' },
};

export const iterationMessage = (locale: McpLocale, code: string): string => ITERATION_MESSAGES[code]?.[locale] ?? ITERATION_MESSAGES['status_not_promotable']![locale];

/** Phrase des usages touchés avant une promotion cassante (07 § 4) : « Ce changement casse {n} usage(s) : {liste}. » */
export function breakingText(locale: McpLocale, impacted: readonly { kind: string; field: string }[]): string {
  const list = [...new Set(impacted.map((i) => `${i.kind === 'view_column' ? (locale === 'fr' ? 'colonne' : 'column') : locale === 'fr' ? 'déduplication' : 'dedup'} ${i.field}`))].join(', ');
  const n = impacted.length;
  if (locale === 'fr') return n === 0 ? 'Ce changement est cassant pour les lecteurs de ces champs.' : `Ce changement casse ${n} usage${n > 1 ? 's' : ''} : ${list}.`;
  return n === 0 ? 'This change is breaking for readers of these fields.' : `This change breaks ${n} use${n > 1 ? 's' : ''}: ${list}.`;
}

/** Élicitation de promotion (Q12) : le diff en une phrase, le coût, la conséquence ; deux valeurs d'enum stables. */
export function promotionElicitation(locale: McpLocale, p: { slug: string; sentence: string; schemaText: string; breaking: string | null; costUsd: number | null }) {
  const cost = fmtUsd(p.costUsd, locale);
  if (locale === 'fr') {
    return {
      message: `Mettre en service le brouillon de « ${p.slug} » ? ${p.sentence}. ${p.schemaText === '' ? '' : `${p.schemaText} `}${p.breaking === null ? '' : `${p.breaking} `}Coût par run : ${cost}. Tu pourras revenir en arrière à tout moment.`.replace(/  +/g, ' '),
      decision: 'Décision',
      promote: 'Mettre en service',
      cancel: 'Annuler',
    };
  }
  return {
    message: `Put the draft of "${p.slug}" in service? ${p.sentence}. ${p.schemaText === '' ? '' : `${p.schemaText} `}${p.breaking === null ? '' : `${p.breaking} `}Cost per run: ${cost}. You can go back at any time.`.replace(/  +/g, ' '),
    decision: 'Decision',
    promote: 'Put in service',
    cancel: 'Cancel',
  };
}

/** Test lancé, pas encore fini dans l'attente : où le retrouver. */
export const testRunningText = (locale: McpLocale): string =>
  locale === 'fr'
    ? 'Le test tourne encore. Relis-le avec get_api (view: iteration) dans quelques secondes : le diff y sera, avec le diff_hash à donner à promote_api.'
    : 'The test is still running. Read it again with get_api (view: iteration) in a few seconds: the diff will be there, with the diff_hash to give to promote_api.';
