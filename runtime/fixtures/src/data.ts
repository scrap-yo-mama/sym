// SPDX-License-Identifier: AGPL-3.0-only
// Jeux de données déterministes (graine fixe). Tout est factice : identifiants zz_test_*, e-mails en .invalid,
// téléphones dans la plage de fiction 01 99 00 xx xx, noms « Zztest ».
import { EPOCH_MS } from './clock.ts';

function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)] as T;
}

export function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function formatEuro(cents: number): string {
  return `${Math.floor(cents / 100)},${pad(cents % 100, 2)} €`;
}

export function slicePage<T>(items: readonly T[], pageNo: number, perPage: number): T[] {
  return items.slice((pageNo - 1) * perPage, pageNo * perPage);
}

const ADJECTIVES = ['Robuste', 'Léger', 'Compact', 'Pliable', 'Modulaire', 'Silencieux', 'Durable', 'Solaire'];
const NOUNS = ['Lampe', 'Support', 'Tiroir', 'Panier', 'Étagère', 'Tabouret', 'Cadre', 'Bac'];
const CATEGORIES = ['maison', 'jardin', 'bureau', 'atelier'];
const CITIES = ['Zzville', 'Testbourg', 'Fixtureville', 'Mockcity', 'Saint-Zztest'];
const FIRST_NAMES = ['Alba', 'Bruno', 'Cyrielle', 'Dario', 'Elise', 'Fabio', 'Gaia', 'Hugo'];

export interface Product {
  id: string;
  title: string;
  price_cents: number;
  currency: 'EUR';
  category: string;
  in_stock: boolean;
}

export function makeProducts(seed: number, siteId: string, n: number): Product[] {
  const rng = mulberry32((seed ^ hashSeed(siteId)) >>> 0);
  return Array.from({ length: n }, (_, i) => ({
    id: `zz_test_product_${pad(i + 1, 4)}`,
    title: `${pick(rng, NOUNS)} ${pick(rng, ADJECTIVES)} Zztest ${pad(i + 1, 4)}`,
    price_cents: 500 + Math.floor(rng() * 9500),
    currency: 'EUR' as const,
    category: pick(rng, CATEGORIES),
    in_stock: rng() > 0.2,
  }));
}

export interface Contact {
  id: string;
  name: string;
  email: string;
  city: string;
  score: number;
  created_at: string;
}

export function makeContacts(seed: number, siteId: string, n: number): Contact[] {
  const rng = mulberry32((seed ^ hashSeed(siteId)) >>> 0);
  return Array.from({ length: n }, (_, i) => ({
    id: `zz_test_contact_${pad(i + 1, 4)}`,
    name: `${pick(rng, FIRST_NAMES)} Zztest${pad(i + 1, 4)}`,
    email: `zz_test_contact_${pad(i + 1, 4)}@example.invalid`,
    city: pick(rng, CITIES),
    score: Math.floor(rng() * 100),
    created_at: new Date(EPOCH_MS - i * 86_400_000).toISOString(),
  }));
}

export interface Person {
  id: string;
  name: string;
  email: string;
  phone: string;
  address: string;
}

export function makePeople(seed: number, siteId: string, n: number): Person[] {
  const rng = mulberry32((seed ^ hashSeed(siteId)) >>> 0);
  return Array.from({ length: n }, (_, i) => ({
    id: `zz_test_person_${pad(i + 1, 3)}`,
    name: `${pick(rng, FIRST_NAMES)} Zztest${pad(i + 1, 3)}`,
    email: `zz_test_person_${pad(i + 1, 3)}@example.invalid`,
    phone: `+33 1 99 00 ${pad(Math.floor(i / 100), 2)} ${pad(i % 100, 2)}`,
    address: `${1 + Math.floor(rng() * 99)} rue du Zztest, 00000 ${pick(rng, CITIES)}`,
  }));
}
