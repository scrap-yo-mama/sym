// SPDX-License-Identifier: AGPL-3.0-only
// Utilitaire de composition de classes de shadcn-vue (clsx + tailwind-merge).
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
