// SPDX-License-Identifier: AGPL-3.0-only
// Mode d'exécution sécurisé (AT_SECURE) du worker de l'image : il tourne sous node-worker, copie de Node dotée de capacités
// de fichier (cap_setuid,cap_setgid, deploy/Dockerfile, constat F-20261001-R01). Le noyau marque alors le processus
// AT_SECURE : Node ignore NODE_OPTIONS et NODE_EXTRA_CA_CERTS, OpenSSL ignore SSL_CERT_FILE, SSL_CERT_DIR et OPENSSL_CONF,
// glibc retire TMPDIR, LD_LIBRARY_PATH, LOCPATH… Le server, lui, les honore : une CA privée (PostgreSQL en verify-full)
// marcherait côté server et échouerait côté worker sans message. Avertissement au démarrage, noms seulement.
import { readFileSync } from 'node:fs';

/** Variables lues par Node ou OpenSSL et ignorées en mode sécurisé (celles que glibc retire ne parviennent pas au worker). */
const IGNORED_UNDER_SECURE_EXEC = ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_CONF'] as const;
/** Type AT_SECURE du vecteur auxiliaire (include/uapi/linux/auxvec.h). */
const AT_SECURE = 23n;

/** Vrai si le noyau a lancé ce processus en mode sécurisé (Linux 64 bits ; faux si /proc/self/auxv est illisible). */
export function isSecureExec(readAuxv: () => Buffer = () => readFileSync('/proc/self/auxv')): boolean {
  let auxv: Buffer;
  try {
    auxv = readAuxv();
  } catch {
    return false;
  }
  for (let offset = 0; offset + 16 <= auxv.length; offset += 16) {
    const type = auxv.readBigUInt64LE(offset);
    if (type === 0n) return false;
    if (type === AT_SECURE) return auxv.readBigUInt64LE(offset + 8) !== 0n;
  }
  return false;
}

/** Avertissement à journaliser si des variables ignorées en mode sécurisé sont posées ; `undefined` sinon. */
export function secureExecIgnoredWarning(env: Readonly<Record<string, string | undefined>>, secure: boolean): string | undefined {
  if (!secure) return undefined;
  const set = IGNORED_UNDER_SECURE_EXEC.filter((name) => (env[name] ?? '') !== '');
  if (set.length === 0) return undefined;
  return (
    `Avertissement : ${set.join(', ')} ${set.length > 1 ? 'sont ignorées' : 'est ignorée'} par le worker (mode d'exécution sécurisé du noyau, ` +
    `AT_SECURE, sous la copie de Node à capacités de fichier de l'image) alors que le server les honore. ` +
    `Une autorité de certification privée passe alors par un autre moyen (PostgreSQL : sslrootcert dans DATABASE_URL ; docs/variables-env.md).`
  );
}
