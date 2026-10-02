// SPDX-License-Identifier: AGPL-3.0-only
// Egress d'une session avec proxy amont (cdc/sym-browser 04c § 2, tâche 1.6). À la création : proxy pris en ligne ou dans un
// profil nommé (identifiants ouverts en mémoire), hôte résolu et épinglé, tunnel authentifié testé par le point d'écho
// (`exitIp`, `latencyMs`). Tout échec : `ProxyUnreachableError` (502 `proxy_unreachable`, motif dans `details`) avant que
// l'egress ne démarre, donc avant tout Chromium. En session, l'egress sort uniquement par cet amont : un refus de l'amont
// donne 502 au navigateur, jamais une sortie directe ni un autre proxy (les proxys sont choisis par l'admin du client).
import type { Socket } from 'node:net';
import { Secret } from '@sym-browser/core';
import type { EgressPolicy, EgressState, UpstreamProxy, UpstreamProxyProfileRef } from '@sym/contracts/browser';
import { EgressDeniedError } from '../guard.js';
import { EgressPolicyError, compileEgressPolicy } from '../policy.js';
import { startSessionEgress, type EgressExit, type SessionEgress, type SessionEgressDeps, type UpstreamTarget } from '../proxy.js';
import { createUpstreamDialer, resolveUpstream, type UpstreamProxyConfig } from './dialer.js';
import { probeExitIp } from './probe.js';
import type { ProxyProfiles } from './profiles.js';
import { UpstreamError, type UpstreamFailure } from './shared.js';

export type ProxyUnreachableReason = UpstreamFailure | 'address_not_public' | 'unresolvable';

/** 502 `proxy_unreachable` (04 § 6) : réessayable, motif dans `details.reason` ; jamais d'identifiant dans le message. */
export class ProxyUnreachableError extends Error {
  override name = 'ProxyUnreachableError';
  readonly code = 'proxy_unreachable';
  readonly status = 502;
  readonly retryable = true;
  readonly details: { reason: ProxyUnreachableReason };
  constructor(reason: ProxyUnreachableReason) {
    super(`proxy amont injoignable (${reason})`);
    this.details = { reason };
  }
  toJSON(): { code: 'proxy_unreachable'; message: string; retryable: true; details: { reason: ProxyUnreachableReason } } {
    return { code: this.code, message: this.message, retryable: this.retryable, details: this.details };
  }
}

export type UpstreamSessionOptions = Omit<SessionEgressDeps, 'dialUpstream' | 'exit'> & {
  tenantId: string;
  /** Profils de proxy nommés du client (`egress.upstream: {profileId}`). */
  profiles?: ProxyProfiles;
  /** Point d'écho du test de connectivité (`SYMB_IP_ECHO_URL`). */
  echoUrl: string;
  /** Délai du test à la création (10 s par défaut, à valider). */
  probeTimeoutMs?: number;
  /** Autorités de certification d'un proxy `https` ou du point d'écho (tests, proxy d'entreprise). */
  ca?: string | Buffer;
  /** Appelé une fois l'egress démarré (preuve « aucun egress, aucun Chromium » sur échec). */
  onEgressStarted?: () => void;
};

export type UpstreamSession = {
  readonly egress: SessionEgress;
  readonly exitIp: string | undefined;
  readonly latencyMs: number | undefined;
  /** `PUT /v1/sessions/{id}/egress` : un nouvel amont est résolu et testé avant d'ouvrir la nouvelle époque. */
  replace(policy: EgressPolicy): Promise<EgressState>;
};

type Prepared = { dial: (target: UpstreamTarget) => Promise<Socket>; exit: EgressExit; policy: EgressPolicy };

const isProfileRef = (upstream: UpstreamProxy | UpstreamProxyProfileRef): upstream is UpstreamProxyProfileRef => 'profileId' in upstream;

/** Proxy amont de la politique, tel que le nœud le tient (profil ouvert ou proxy en ligne, mot de passe en `Secret`). */
async function upstreamConfig(policy: EgressPolicy, options: UpstreamSessionOptions): Promise<{ config: UpstreamProxyConfig; dnsViaProxy: boolean | undefined }> {
  const upstream = policy.upstream as UpstreamProxy | UpstreamProxyProfileRef;
  if (isProfileRef(upstream)) {
    if (options.profiles === undefined) throw new EgressPolicyError('egress.upstream.profileId', 'aucun profil de proxy sur ce nœud');
    const { dnsViaProxy, ...config } = await options.profiles.open(options.tenantId, upstream.profileId);
    return { config, dnsViaProxy };
  }
  const { password, ...rest } = upstream;
  return { config: { ...rest, ...(password === undefined ? {} : { password: new Secret(password) }) }, dnsViaProxy: undefined };
}

/** Résolution de l'amont, relais, test d'écho ; politique rendue à l'egress sans identifiant. */
async function prepare(policy: EgressPolicy, options: UpstreamSessionOptions): Promise<Prepared> {
  compileEgressPolicy(policy);
  const { config, dnsViaProxy } = await upstreamConfig(policy, options);
  const effective: EgressPolicy = {
    ...policy,
    // Seuls type, hôte et port restent dans la politique gardée par l'egress : les identifiants vivent dans le relais.
    upstream: { type: config.type, host: config.host, port: config.port },
    dnsViaProxy: policy.dnsViaProxy ?? dnsViaProxy ?? true,
  };
  const viaProxyDns = effective.dnsViaProxy !== false;
  try {
    const resolved = await resolveUpstream(config, options.guard);
    const timeout = options.probeTimeoutMs ?? options.connectTimeoutMs ?? 10_000;
    const dial = createUpstreamDialer(resolved, { connectTimeoutMs: timeout, ...(options.ca === undefined ? {} : { ca: options.ca }) });
    // Le point d'écho suit la même garde que la navigation : nom contrôlé (dnsViaProxy) ou adresse épinglée.
    const probeDial = async (target: UpstreamTarget): Promise<Socket> => {
      if (viaProxyDns) {
        options.guard.checkName(target.host, target.port);
        return dial(target);
      }
      return dial({ ...target, address: (await options.guard.resolve(target.host, target.port)).address });
    };
    const exit = await probeExitIp(probeDial, options.echoUrl, { timeoutMs: timeout, ...(options.ca === undefined ? {} : { ca: options.ca }) });
    return { dial, exit, policy: effective };
  } catch (error) {
    if (error instanceof UpstreamError) throw new ProxyUnreachableError(error.reason);
    if (error instanceof EgressDeniedError) throw new ProxyUnreachableError(error.reason === 'unresolvable' ? 'unresolvable' : 'address_not_public');
    throw error;
  }
}

/** Démarre l'egress d'une session, branché sur son proxy amont s'il y en a un (04c § 6.1, tâches 1.5 et 1.6). */
export async function startUpstreamSessionEgress(policy: EgressPolicy, options: UpstreamSessionOptions): Promise<UpstreamSession> {
  const { tenantId: _tenant, profiles: _profiles, echoUrl: _echo, probeTimeoutMs: _probe, ca: _ca, onEgressStarted, ...deps } = options;
  let prepared = policy.upstream === undefined ? undefined : await prepare(policy, options);
  const egress = await startSessionEgress(prepared?.policy ?? policy, {
    ...deps,
    ...(prepared === undefined ? {} : { exit: prepared.exit }),
    // Toujours le relais courant : un `replace` réussi bascule l'amont, sans jamais retomber sur une sortie directe.
    dialUpstream: async (target) => {
      if (prepared === undefined) throw new UpstreamError('connect_failed');
      return prepared.dial(target);
    },
  });
  onEgressStarted?.();
  return {
    egress,
    get exitIp() {
      return prepared?.exit.exitIp;
    },
    get latencyMs() {
      return prepared?.exit.latencyMs;
    },
    replace: async (next) => {
      if (next.upstream === undefined) {
        const state = egress.replace(next);
        prepared = undefined;
        return state;
      }
      const ready = await prepare(next, options);
      prepared = ready;
      return egress.replace(ready.policy, ready.exit);
    },
  };
}
