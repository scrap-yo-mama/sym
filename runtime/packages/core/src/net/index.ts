// Garde SSRF et proxy d'egress (INV10, 08b §1). Exporté en sous-chemin `@runtime/core/net` : ce module fait des
// I/O (DNS, sockets) et dépend d'undici, contrairement à la racine de `@runtime/core`.
export * from './ip.js';
export * from './guard.js';
export * from './fetch.js';
export * from './egress-proxy.js';
export * from './chromium.js';
export * from './webhook.js';
export * from './modes/index.js';
