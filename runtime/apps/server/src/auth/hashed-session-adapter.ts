// SPDX-License-Identifier: AGPL-3.0-only
// Surcouche de l'adaptateur Better Auth (13 § 5, point imposé 1 de 0.3b) : la base ne contient qu'un SHA-256 du jeton
// de session (colonne `auth_sessions.token_hash`), jamais le jeton. Better Auth manipule le jeton en clair (cookie
// signé) : à l'écriture on hache `token`, dans chaque clause `where` sur `token` on hache la valeur, et en sortie on
// remet le jeton reçu quand il est connu (sinon la ligne garde l'empreinte, inutilisable comme jeton).
// Les transactions de la bibliothèque passent aussi par la surcouche (adaptateur de transaction enveloppé).
import { createHash } from 'node:crypto';
import type { DBAdapter, DBTransactionAdapter, Where } from 'better-auth/types';

const SESSION_MODELS = new Set(['session', 'auth_sessions']);

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

type Row = Record<string, unknown>;
type Known = Map<string, string>; // empreinte → jeton

function hashWhere(where: Where[] | undefined, known: Known): Where[] | undefined {
  return where?.map((w) => {
    if (w.field !== 'token') return w;
    if (typeof w.value === 'string') {
      const h = hashSessionToken(w.value);
      known.set(h, w.value);
      return { ...w, value: h };
    }
    if (Array.isArray(w.value)) {
      return {
        ...w,
        value: (w.value as unknown[]).map((v) => {
          const h = hashSessionToken(String(v));
          known.set(h, String(v));
          return h;
        }) as string[],
      };
    }
    return w;
  });
}

function hashData(data: Row | undefined, known: Known): Row | undefined {
  if (!data || typeof data.token !== 'string') return data;
  const h = hashSessionToken(data.token);
  known.set(h, data.token);
  return { ...data, token: h };
}

function restore<T>(value: T, known: Known): T {
  if (Array.isArray(value)) return value.map((v) => restore(v, known)) as T;
  if (value && typeof value === 'object' && typeof (value as Row).token === 'string') {
    const token = known.get((value as Row).token as string);
    if (token !== undefined) return { ...(value as Row), token } as T;
  }
  return value;
}

type AnyAdapter = DBAdapter | DBTransactionAdapter;
type Args = { model: string; where?: Where[]; data?: Row; update?: Row } & Row;

const METHODS = ['create', 'findOne', 'findMany', 'count', 'update', 'updateMany', 'delete', 'deleteMany', 'consumeOne', 'incrementOne'] as const;

function wrap<A extends AnyAdapter>(inner: A): A {
  const out: Row = { ...inner };
  for (const name of METHODS) {
    const fn = (inner as unknown as Row)[name];
    if (typeof fn !== 'function') continue;
    out[name] = async (args: Args) => {
      if (!SESSION_MODELS.has(args.model)) return fn.call(inner, args);
      const known: Known = new Map();
      const next: Args = { ...args };
      if (args.where) next.where = hashWhere(args.where, known);
      if (args.data) next.data = hashData(args.data, known);
      if (args.update) next.update = hashData(args.update, known);
      return restore(await fn.call(inner, next), known);
    };
  }
  if ('transaction' in inner && typeof inner.transaction === 'function') {
    const transaction = inner.transaction.bind(inner);
    out.transaction = <R>(cb: (trx: DBTransactionAdapter) => Promise<R>) => transaction((trx) => cb(wrap(trx)));
  }
  return out as unknown as A;
}

/** Enveloppe une fabrique d'adaptateur (`drizzleAdapter(db, config)`) : même signature, jetons hachés. */
export function withHashedSessionTokens<O>(factory: (options: O) => DBAdapter): (options: O) => DBAdapter {
  return (options) => wrap(factory(options));
}
