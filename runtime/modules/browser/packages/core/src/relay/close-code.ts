// SPDX-License-Identifier: AGPL-3.0-only
// Codes de fermeture WebSocket propagés par les relais (passerelle et nœud, tâche 2.3, 04 § 8) : 1005, 1006, 1015 et les
// codes hors plages ne peuvent pas être envoyés dans une trame ; une coupure (1006) devient une erreur du relais (1011).
export function sendableCloseCode(code: number): number {
  if (code === 1000 || (code >= 3000 && code <= 4999)) return code;
  if (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code;
  return code === 1006 ? 1011 : 1000;
}
