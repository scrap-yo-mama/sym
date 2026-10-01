// SPDX-License-Identifier: AGPL-3.0-only
// User-Agent du robot pour chaque run (tâche 1.11, 17 §5) : `Scrapyomama/<version> (+<contact de l'instance>)`. Le contact
// vient du réglage `instance_contact` puis de `INSTANCE_CONTACT`. Sans lui, le robot part en `Scrapyomama/<version>` et
// le manque est JOURNALISÉ (avertissement `instance_contact_missing`, une fois par exécuteur) : 17 §5 l'exige avant la
// première enquête, ce que 2.1 fera respecter (`requireInstanceContact` au début de l'enquête) ; l'assistant de premier
// démarrage, qui doit écrire le réglage, n'a pas encore ce champ.
import { buildUserAgent } from '@runtime/core/access';

export type RobotIdentityOptions = {
  readonly version?: string;
  readonly instanceContact?: () => Promise<string | null>;
  /** Avertissement (code seul, jamais le contact). */
  readonly warn: (code: 'instance_contact_missing') => void;
};

/** User-Agent d'un run ; lève `InstanceContactError` si le contact enregistré est invalide (le run est alors refusé). */
export function robotIdentity(options: RobotIdentityOptions): () => Promise<string> {
  let warned = false;
  return async () => {
    const contact = (await options.instanceContact?.()) ?? null;
    if (contact === null && !warned) {
      warned = true;
      options.warn('instance_contact_missing');
    }
    return buildUserAgent({ version: options.version ?? '0.0.0', contact });
  };
}
