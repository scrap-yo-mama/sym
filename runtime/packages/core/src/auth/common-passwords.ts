// SPDX-License-Identifier: AGPL-3.0-only
// Liste locale des mots de passe compromis les plus courants d'au moins 12 caractères (13 § 5), en minuscules.
// Embarquée : aucun appel externe (INV9). Taille de la liste « à valider » (13 § 14) : amorce issue des palmarès
// publics de fuites, à étendre sans changer l'API.
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  '123456789012', '1234567890123', '12345678901234', '123456789123', '123123123123', '111111111111', '000000000000',
  '121212121212', '147258369147', '123456123456', '112233445566', '987654321098', '098765432109', '123qweasdzxc',
  'qwertyuiopas', 'qwertyuiop12', 'qwertyuiop123', 'qwerty123456', 'qwerty12345678', '1qaz2wsx3edc', '1q2w3e4r5t6y',
  '1q2w3e4r5t6y7u', 'zaq12wsxcde3', 'asdfghjkl123', 'asdfghjkl;\'', 'zxcvbnm12345', 'qazwsxedcrfv', 'azertyuiop12',
  'azerty123456', 'password1234', 'password12345', 'password123456', 'password1234567', 'passwordpassword',
  'password!123', 'p@ssw0rd1234', 'p@ssword1234', 'motdepasse123', 'motdepasse1234', 'iloveyou1234', 'iloveyou12345',
  'letmein12345', 'welcome12345', 'welcome123456', 'administrator', 'administrator1', 'admin1234567', 'adminadmin123',
  'changeme1234', 'football1234', 'baseball1234', 'superman1234', 'princess1234', 'sunshine1234', 'starwars1234',
  'dragon123456', 'monkey123456', 'master123456', 'trustno1trustno1', 'aaaaaaaaaaaa', 'abcdefghijkl', 'abcd1234abcd',
  'abc123abc123', 'abcdef123456', 'thequickbrownfox', 'correcthorsebatterystaple', 'qwertyqwerty', 'loveyouforever',
  'soleil123456', 'bonjour123456', 'chocolat1234', 'doudou123456', 'marseille1234', 'scrapyomama123',
]);
