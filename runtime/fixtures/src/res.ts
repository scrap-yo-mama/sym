// SPDX-License-Identifier: AGPL-3.0-only
import type { FxRequest, FxResponse } from './core.ts';

export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function json(status: number, value: unknown, headers: Record<string, string | string[]> = {}): FxResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(value) };
}

export function html(status: number, body: string, headers: Record<string, string | string[]> = {}): FxResponse {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body };
}

export function text(status: number, body: string, headers: Record<string, string | string[]> = {}): FxResponse {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, body };
}

export function redirect(status: number, location: string, headers: Record<string, string> = {}): FxResponse {
  return { status, headers: { location, ...headers }, body: '' };
}

export function page(title: string, body: string, head = ''): string {
  return `<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><title>${esc(title)}</title>${head}</head><body>${body}</body></html>`;
}

export function headerOf(req: FxRequest, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function cookieOf(req: FxRequest, name: string): string | undefined {
  for (const part of (headerOf(req, 'cookie') ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

export function intParam(req: FxRequest, name: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(req.query.get(name) ?? '', 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
