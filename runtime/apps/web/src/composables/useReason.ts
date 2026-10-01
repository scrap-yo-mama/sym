// SPDX-License-Identifier: AGPL-3.0-only
// Traduction des codes stables du serveur en phrases (06 § 4.1, § 4.2) : l'API renvoie `{ code, params }`, jamais une phrase.
// Un code sans traduction retombe sur « Raison : {code} » (jamais une page blanche, jamais le code nu sans contexte).
import { useI18n } from 'vue-i18n';
import type { ReasonView } from '@/lib/investigation';

export function useReason() {
  const { t, te } = useI18n();

  /** Phrase complète d'une raison (06 § 4.2), avec ses nombres. */
  function reasonText(reason: ReasonView): string {
    return te(`reason.${reason.code}`) ? t(`reason.${reason.code}`, reason.params) : t('reason.unknown', { code: reason.code });
  }

  /** Libellé court d'un code de raison de liste (sans paramètre), sinon la phrase complète. */
  function reasonShort(code: string): string {
    return te(`reasonShort.${code}`) ? t(`reasonShort.${code}`) : reasonText({ code, params: {} });
  }

  /** Libellé d'un résultat d'essai : `ok` ou une classe d'échec (les familles `llm_*` partagent un libellé). */
  function resultLabel(result: string): string {
    if (result === 'ok') return t('failure.ok');
    const key = result.startsWith('llm_') ? 'failure.llm' : `failure.${result}`;
    return te(key) ? t(key) : t('reason.unknown', { code: result });
  }

  return { reasonText, reasonShort, resultLabel };
}
