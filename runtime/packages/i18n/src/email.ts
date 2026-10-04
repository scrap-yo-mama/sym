// SPDX-License-Identifier: AGPL-3.0-only
// E-mails localisés (21 § 4.6, M9) : un gabarit, des chaînes par langue (`email.*`), un e-mail = une langue. Texte brut + HTML
// minimal avec `lang`, en-tête `Content-Language`, tutoiement, aucune touche légère, aucun pixel de suivi (INV9), aucune
// variable non résolue. Les heures sont dans `users.timezone`, sinon UTC étiqueté.
import { fmtDate } from './format.js';
import type { Renderer } from './render.js';

export type EmailKind = 'invite' | 'reset' | 'alert';

export interface RenderedEmail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Langue du message : `lang` du HTML et valeur de `Content-Language`. */
  readonly lang: string;
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function document(lang: string, subject: string, paragraphs: readonly string[], link: string | null): string {
  const body = paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`);
  if (link !== null) body.splice(Math.min(2, body.length), 0, `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`);
  return `<!doctype html>\n<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head><body>${body.join('')}</body></html>\n`;
}

export interface InviteParams { inviter: string; instance: string; link: string; expiresAt: Date }
export interface ResetParams { instance: string; link: string; expiresAt: Date }

/** E-mail d'invitation, dans `invitations.locale`. L'heure d'expiration est en UTC étiqueté (l'invité n'a pas de compte). */
export function renderInviteEmail(renderer: Renderer, p: InviteParams, locale: string): RenderedEmail {
  const expires = fmtDate(p.expiresAt, locale, null);
  const subject = renderer.render('email.invite.subject', { inviter: p.inviter, instance: p.instance }, locale);
  const intro = renderer.render('email.invite.intro', { inviter: p.inviter, instance: p.instance }, locale);
  const action = renderer.render('email.invite.action', { expires }, locale);
  const ignore = renderer.render('email.invite.ignore', {}, locale);
  return { subject, text: `${intro}\n\n${action}\n${p.link}\n\n${ignore}\n`, html: document(locale, subject, [intro, action, ignore], p.link), lang: locale };
}

/** E-mail de réinitialisation du mot de passe, dans `users.locale`, heure dans `users.timezone` (sinon UTC étiqueté). */
export function renderResetEmail(renderer: Renderer, p: ResetParams, locale: string, timeZone?: string | null): RenderedEmail {
  const expires = fmtDate(p.expiresAt, locale, timeZone);
  const subject = renderer.render('email.reset.subject', { instance: p.instance }, locale);
  const intro = renderer.render('email.reset.intro', { instance: p.instance }, locale);
  const action = renderer.render('email.reset.action', { expires }, locale);
  const ignore = renderer.render('email.reset.ignore', {}, locale);
  return { subject, text: `${intro}\n\n${action}\n${p.link}\n\n${ignore}\n`, html: document(locale, subject, [intro, action, ignore], p.link), lang: locale };
}

export interface AlertEmailParams {
  api: string;
  cause: string;
  runId?: string | null;
  failureClass?: string | null;
  warningSince?: Date | null;
  transitions: readonly { at: Date; from: string | null; to: string; reason: string | null }[];
  consoleUrl?: string | null;
}

/** E-mail d'alerte : factuel, sans reproche, jamais d'item ni de secret. Heures en UTC étiqueté (destinataires = adresses, pas comptes). */
export function renderAlertEmailLocalized(renderer: Renderer, p: AlertEmailParams, locale: string, timeZone?: string | null): RenderedEmail {
  const label = (name: string) => renderer.render(`email.alert.label.${name}`, {}, locale);
  const colon = locale === 'fr' ? ' : ' : ': ';
  const cause = renderer.has(`email.alert.cause.${p.cause}.title`, 'en') ? p.cause : 'run_failed';
  const title = renderer.render(`email.alert.cause.${cause}.title`, {}, locale);
  const body = renderer.render(`email.alert.cause.${cause}.body`, {}, locale);
  const subject = renderer.render('email.alert.subject', { api: p.api, cause: title }, locale);
  const lines = [body, '', `${label('api')}${colon}${p.api}`];
  if (p.runId) lines.push(`${label('run')}${colon}${p.runId}`);
  if (p.failureClass) lines.push(`${label('failure_class')}${colon}${p.failureClass}`);
  if (p.warningSince) lines.push(`${label('warning_since')}${colon}${fmtDate(p.warningSince, locale, timeZone)}`);
  if (p.transitions.length > 0) {
    lines.push(`${label('transitions')}${colon}${p.transitions.length}`);
    for (const t of p.transitions) lines.push(`  ${fmtDate(t.at, locale, timeZone)}  ${t.from ?? '-'} -> ${t.to}${t.reason ? ` (${t.reason})` : ''}`);
  }
  if (p.consoleUrl) lines.push('', `${label('console')}${colon}${p.consoleUrl.replace(/\/+$/, '')}/apis/${encodeURIComponent(p.api)}`);
  return { subject, text: `${lines.join('\n')}\n`, html: document(locale, subject, [lines.slice(0, 1)[0] ?? '', lines.slice(2).join('\n')], null), lang: locale };
}
