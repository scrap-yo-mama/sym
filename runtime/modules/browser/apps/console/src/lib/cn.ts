// SPDX-License-Identifier: AGPL-3.0-only
// Composition de classes Tailwind (clsx puis tailwind-merge : la dernière classe d'une même propriété l'emporte).
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
