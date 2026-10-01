// SPDX-License-Identifier: AGPL-3.0-only
// Identité du robot pour chaque run (tâche 1.11, 17 §5, décision du 2026-10-01) : le User-Agent RÉEL du moteur embarqué
// (`buildUserAgent`, @runtime/core/access), identique pour toute l'image. Si l'admin active `identify_instance` (désactivé
// par défaut), le jeton `compatible; Scrapyomama/<version>; +<contact>` s'y ajoute et, quand le contact est une adresse
// électronique, l'en-tête `From`. Le contact vient du réglage `instance_contact` puis de `INSTANCE_CONTACT` ; invalide, il
// refuse le run (`InstanceContactError`). Absent alors que l'identification est activée, le jeton part sans contact et le
// manque est JOURNALISÉ (avertissement `instance_contact_missing`, une fois par exécuteur) ; 17 §5 l'exige avant la
// première enquête, ce que 2.1 fera respecter (`requireInstanceContact`).
import { buildUserAgent, robotFrom, type EngineIdentity } from '@runtime/core/access';
import { installedEngineIdentity } from '../browser/engine-identity.js';

export type RobotIdentityOptions = {
  readonly version?: string;
  readonly instanceContact?: () => Promise<string | null>;
  /** Réglage `identify_instance`, relu à chaque run ; défaut : désactivé. */
  readonly identifyInstance?: () => Promise<boolean>;
  /** Moteur embarqué ; défaut : le Chromium épinglé par le Playwright installé. */
  readonly engine?: () => EngineIdentity;
  /** Avertissement (code seul, jamais le contact). */
  readonly warn: (code: 'instance_contact_missing') => void;
};

/** Identité d'un run : le User-Agent, et l'en-tête `From` quand elle s'applique (`null` sinon). */
export type RobotIdentity = { readonly userAgent: string; readonly from: string | null };

/** Identité d'un run ; lève `InstanceContactError` si le contact enregistré est invalide (le run est alors refusé). */
export function robotIdentity(options: RobotIdentityOptions): () => Promise<RobotIdentity> {
  let warned = false;
  return async () => {
    const contact = (await options.instanceContact?.()) ?? null;
    const engine = (options.engine ?? installedEngineIdentity)();
    if (!((await options.identifyInstance?.()) ?? false)) return { userAgent: buildUserAgent({ engine }), from: null };
    if (contact === null && !warned) {
      warned = true;
      options.warn('instance_contact_missing');
    }
    return { userAgent: buildUserAgent({ engine, identify: { version: options.version ?? '0.0.0', contact } }), from: robotFrom(contact) };
  };
}
