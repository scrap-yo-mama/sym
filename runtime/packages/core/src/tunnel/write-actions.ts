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

const ACTIVATION_KEYS = new Set(['Enter', ' ', 'Spacebar', 'Space', '\r', '\n']);
const ACTIVATION_CODES = new Set(['Enter', 'NumpadEnter', 'Space']);
const ACTIVATION_KEY_CODES = new Set([13, 32]);

/**
 * `Input.dispatchKeyEvent` qui peut envoyer un formulaire ou activer l'élément focalisé (07 §5, 08 §4) : Entrée
 * (soumission implicite) ou Espace (bouton focalisé), quelle que soit la façon de les décrire (`key`, `code`, `text`,
 * `windowsVirtualKeyCode`). Fermé par défaut : sans `allow_write_actions`, l'extension les refuse toutes ; le texte se
 * saisit par `Input.insertText`, qui n'active rien.
 */
export function isActivationKey(params: Readonly<Record<string, unknown>>): boolean {
  const { key, code, text, windowsVirtualKeyCode: vk } = params;
  if (typeof key === 'string' && ACTIVATION_KEYS.has(key)) return true;
  if (typeof code === 'string' && ACTIVATION_CODES.has(code)) return true;
  if (typeof vk === 'number' && ACTIVATION_KEY_CODES.has(vk)) return true;
  return typeof text === 'string' && /[\r\n ]/.test(text);
}

/**
 * Élément DOM dont l'activation (clic, focus puis Entrée ou Espace) envoie un formulaire : `<button>` sans type ou
 * `type=submit`, `<input type=submit|image>`. Fermé : un bouton sans type, dans un formulaire, l'envoie.
 */
export function isWriteElement(node: { readonly nodeName?: string; readonly attributes?: readonly string[] }): boolean {
  const attrs = node.attributes ?? [];
  const at = attrs.findIndex((a, i) => i % 2 === 0 && a.toLowerCase() === 'type');
  const type = at === -1 ? undefined : attrs[at + 1]?.toLowerCase();
  const name = (node.nodeName ?? '').toUpperCase();
  if (name === 'BUTTON') return type === undefined || type === 'submit' || type === '';
  if (name === 'INPUT') return type === 'submit' || type === 'image';
  return false;
}
