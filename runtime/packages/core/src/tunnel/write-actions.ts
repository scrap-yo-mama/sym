// SPDX-License-Identifier: AGPL-3.0-only
// Garde d'écriture du tunnel (07 §5, 08 §4) : pas de « submit » générique. Un clic sur un bouton d'envoi, d'achat, de
// publication ou de suppression est une écriture, bloquée (`write_action_blocked`) tant que l'API n'a pas été créée
// avec `allow_write_actions` confirmé dans l'interface. Fermé par défaut : un bouton de formulaire `type=submit` est
// une écriture, quel que soit son libellé.

const WRITE_WORDS = [
  // anglais
  'submit', 'send', 'post', 'publish', 'buy', 'purchase', 'pay', 'order', 'checkout', 'check out', 'place order', 'delete',
  'remove', 'confirm', 'sign up', 'register', 'subscribe', 'unsubscribe', 'book', 'reserve', 'donate', 'transfer',
  'save', 'reply', 'comment', 'share', 'like', 'follow', 'invite', 'upload', 'add to cart', 'add to basket',
  // français
  'envoyer', 'valider', 'publier', 'acheter', 'payer', 'commander', 'supprimer', 'effacer', 'confirmer', "s'inscrire",
  'inscription', "s'abonner", 'se désabonner', 'postuler', 'réserver', 'enregistrer', 'répondre', 'commenter',
  'partager', 'aimer', 'suivre', 'inviter', 'téléverser', 'ajouter au panier',
];

const PATTERN = new RegExp(`(^|[^\\p{L}])(${WRITE_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|')})($|[^\\p{L}])`, 'iu');

/** Rôles accessibles sur lesquels un clic peut déclencher une écriture. */
const ACTION_ROLES = new Set(['button', 'menuitem', 'link', 'switch', 'checkbox', 'radio', 'option', 'tab']);

/** Le clic sur cet élément est-il une écriture ? `submit` : bouton de formulaire `type=submit` (ou image). */
export function isWriteTarget(target: { readonly role: string; readonly name: string; readonly submit?: boolean }): boolean {
  if (target.submit === true) return true;
  if (!ACTION_ROLES.has(target.role.toLowerCase())) return false;
  return PATTERN.test(target.name);
}

/** La touche envoie-t-elle un formulaire ? (Entrée) */
export function isSubmitKey(key: unknown, code?: unknown): boolean {
  return key === 'Enter' || code === 'Enter' || code === 'NumpadEnter' || key === '\r';
}
