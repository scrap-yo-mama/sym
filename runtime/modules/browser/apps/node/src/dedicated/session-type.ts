// SPDX-License-Identifier: AGPL-3.0-only
// Type effectif d'une session (03 § 3, 04f § 1) : la règle vit dans @sym-browser/core depuis la tâche 2.2, partagée avec la
// passerelle qui fixe le type à la création.
export { resolveSessionType, type ResolvedSessionType } from '@sym-browser/core';
