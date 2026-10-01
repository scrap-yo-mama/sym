// SPDX-License-Identifier: AGPL-3.0-only
// Bibliothèque de la console (tâche 3.4) : formulaire généré depuis `input_schema`, diff brut côte à côte, replay d'enquête
// (lecture des trames, délais, saut de phase), formats d'affichage, textes de raison.
import { effectScope, ref } from 'vue';
import { describe, expect, test } from 'vitest';
import { useReplayPlayer } from '@/composables/useReplayPlayer';
import { describeCron } from '@/lib/cron';
import { formatAgo, formatDuration, formatPercent, formatUsd } from '@/lib/display-format';
import { jsonLines, sideBySide } from '@/lib/line-diff';
import { describeFailureClass, describeReason, describeReasonCode, reasonParams } from '@/lib/reasons';
import { delayBefore, describeReplayEvent, parseReplayEvent, phaseStarts, replayKindKey, type ReplayEvent } from '@/lib/replay';
import { buildFormModel, exampleInput, initialValues, toInput } from '@/lib/schema-form';
import { actionCause } from '@/lib/action-required';
import { safeHref } from '@/lib/links';
import type { SseEvent } from '@/lib/sse';

describe('schema-form', () => {
  const schema = {
    type: 'object',
    required: ['max_pages', 'url'],
    properties: {
      url: { type: 'string', description: 'Adresse' },
      max_pages: { type: 'integer' },
      ratio: { type: 'number' },
      dry: { type: 'boolean', default: true },
      category: { type: 'string', enum: ['all', 'fiction'] },
      tags: { type: 'array', items: { type: 'string' } },
      sizes: { type: 'array', items: { type: 'integer' } },
    },
  };

  test('un champ par type pris en charge (string, number, integer, boolean, enum, array de scalaires)', () => {
    const model = buildFormModel(schema);
    expect(model.needsJsonEditor).toBe(false);
    expect(model.fields.map((field) => [field.name, field.kind, field.required])).toEqual([
      ['url', 'string', true],
      ['max_pages', 'integer', true],
      ['ratio', 'number', false],
      ['dry', 'boolean', false],
      ['category', 'enum', false],
      ['tags', 'array', false],
      ['sizes', 'array', false],
    ]);
  });

  test('les autres types (objet, tableau d’objets, oneOf) basculent vers la saisie JSON', () => {
    expect(buildFormModel({ type: 'object', properties: { f: { type: 'object' } } }).needsJsonEditor).toBe(true);
    expect(buildFormModel({ type: 'object', properties: { f: { type: 'array', items: { type: 'object' } } } }).needsJsonEditor).toBe(true);
    expect(buildFormModel({ type: 'object', properties: { f: { oneOf: [{ type: 'string' }] } } }).needsJsonEditor).toBe(true);
    expect(buildFormModel({ type: 'array' }).needsJsonEditor).toBe(true);
    expect(buildFormModel(undefined)).toEqual({ fields: [], needsJsonEditor: false });
  });

  test('toInput : types convertis, champs facultatifs vides omis, saisie non numérique laissée au serveur (400)', () => {
    const model = buildFormModel(schema);
    const values = initialValues(model);
    Object.assign(values, { url: 'https://a.example', max_pages: '4', ratio: '', dry: false, category: 'fiction', tags: ' a, b ,,c', sizes: '1, 2' });
    expect(toInput(model, values)).toEqual({ url: 'https://a.example', max_pages: 4, dry: false, category: 'fiction', tags: ['a', 'b', 'c'], sizes: [1, 2] });
    expect(toInput(model, { ...values, max_pages: 'beaucoup', ratio: '0.5' })).toMatchObject({ max_pages: 'beaucoup', ratio: 0.5 });
    expect(toInput(model, { ...values, max_pages: '4.5' }).max_pages).toBe('4.5');
  });

  test('exampleInput : champs obligatoires et valeurs par défaut seulement', () => {
    expect(exampleInput(buildFormModel(schema))).toEqual({ url: '…', max_pages: 1, dry: true });
  });
});

describe('line-diff', () => {
  test('jsonLines trie les clés (affichage stable) et accepte null', () => {
    expect(jsonLines({ b: 1, a: { d: 1, c: 2 } })).toEqual(['{', '  "a": {', '    "c": 2,', '    "d": 1', '  },', '  "b": 1', '}']);
    expect(jsonLines(null)).toEqual([]);
  });

  test('côte à côte : lignes communes, modifiées, ajoutées, retirées, avec leurs numéros', () => {
    const rows = sideBySide({ a: 1, b: 2 }, { a: 1, b: 3, c: 4 });
    expect(rows.map((row) => row.kind)).toEqual(['same', 'same', 'changed', 'added', 'same']);
    const changed = rows.find((row) => row.kind === 'changed');
    expect(changed).toMatchObject({ left: '  "b": 2', right: '  "b": 3,', leftNo: 3, rightNo: 3 });
    expect(sideBySide({ a: 1 }, { a: 1 }).every((row) => row.kind === 'same')).toBe(true);
    expect(sideBySide(null, { a: 1 }).every((row) => row.kind === 'added')).toBe(true);
    expect(sideBySide({ a: 1 }, null).every((row) => row.kind === 'removed')).toBe(true);
  });

  test('un diff énorme ne fige pas la console : retrait puis ajout, sans table de comparaison', () => {
    const big = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`k${i}`, i]));
    const other = Object.fromEntries(Array.from({ length: 2500 }, (_, i) => [`k${i}`, i + 1]));
    const rows = sideBySide(big, other);
    expect(rows.length).toBeGreaterThan(2500);
    expect(rows.some((row) => row.kind === 'changed')).toBe(true);
  });
});

describe('replay', () => {
  const frame = (data: unknown, event = 'attempt.finished', id: string | null = '1'): SseEvent => ({ id, event, data: JSON.stringify(data) });

  test('parseReplayEvent : nom, séquence, date, paramètres scalaires de la charge ; trame illisible ignorée', () => {
    const event = parseReplayEvent(frame({ seq: 4, at: '2026-10-01T08:00:00Z', payload: { n: 2, execution: 'fetch', nested: { a: 1 }, list: [1] } }), 1);
    expect(event).toEqual({ id: '1', seq: 4, kind: 'attempt.finished', at: '2026-10-01T08:00:00Z', params: { n: 2, execution: 'fetch' } });
    expect(parseReplayEvent({ id: null, event: 'x', data: 'pas du json' }, 1)).toBeNull();
    expect(parseReplayEvent({ id: null, event: 'message', data: '{}' }, 1)).toBeNull();
    expect(parseReplayEvent(frame({ kind: 'access_report', payload: { robots: 'allowed' } }, 'message'), 7)).toMatchObject({ kind: 'access_report', seq: 7 });
  });

  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1, 8, 0, seconds)).toISOString();
  const events: ReplayEvent[] = [
    { id: '1', seq: 1, kind: 'investigation.started', at: at(0), params: {} },
    { id: '2', seq: 2, kind: 'phase.started', at: at(1), params: { phase: 'access_check' } },
    { id: '3', seq: 3, kind: 'attempt.finished', at: at(40), params: { n: 1 } },
    { id: '4', seq: 4, kind: 'phase.started', at: at(41), params: { phase: 'testing' } },
    { id: '5', seq: 5, kind: 'attempt.finished', at: at(42), params: { n: 2 } },
  ];

  test('delayBefore : vitesse 0,5x à 4x, pause plafonnée, plancher pour les événements simultanés', () => {
    expect(delayBefore(events, 0, 1)).toBe(0);
    expect(delayBefore(events, 1, 1)).toBe(1000);
    expect(delayBefore(events, 1, 4)).toBe(250);
    expect(delayBefore(events, 1, 0.5)).toBe(2000);
    expect(delayBefore(events, 2, 1)).toBe(3000);
    expect(delayBefore([events[0]!, { ...events[0]!, at: events[0]!.at }], 1, 1)).toBe(60);
    expect(delayBefore([events[0]!, { ...events[0]!, at: null }], 1, 2)).toBe(30);
  });

  test('phaseStarts : index des débuts de phase', () => {
    expect(phaseStarts(events)).toEqual([{ index: 1, phase: 'access_check' }, { index: 3, phase: 'testing' }]);
  });

  test('lecteur : lecture pas à pas, pause, vitesse, saut de phase en avant et en arrière, recherche du début', () => {
    const scope = effectScope();
    const queue: { run: () => void; ms: number }[] = [];
    const schedule = (run: () => void, ms: number) => {
      const entry = { run, ms };
      queue.push(entry);
      return () => queue.splice(queue.indexOf(entry), 1);
    };
    scope.run(() => {
      const player = useReplayPlayer(ref(events), schedule);
      expect(player.shown.value).toBe(0);
      player.play();
      expect(queue.at(-1)?.ms).toBe(0);
      queue.pop()?.run();
      expect(player.shown.value).toBe(1);
      expect(queue.at(-1)?.ms).toBe(1000);
      player.setSpeed(4);
      expect(queue.at(-1)?.ms).toBe(250);
      player.pause();
      expect(queue).toHaveLength(0);
      player.jumpPhase(1);
      expect(player.shown.value).toBe(2);
      player.jumpPhase(1);
      expect(player.shown.value).toBe(4);
      player.jumpPhase(1);
      expect(player.shown.value).toBe(5);
      player.jumpPhase(-1);
      expect(player.shown.value).toBe(4);
      player.jumpPhase(-1);
      expect(player.shown.value).toBe(2);
      player.jumpPhase(-1);
      expect(player.shown.value).toBe(0);
      player.showAll();
      expect(player.atEnd.value).toBe(true);
      expect(player.visible.value).toHaveLength(5);
      player.play();
      expect(player.shown.value).toBe(0);
      player.restart();
      expect(player.shown.value).toBe(0);
    });
    scope.stop();
    expect(queue).toHaveLength(0);
  });

  test('describeReplayEvent : phrase par événement, valeurs traduites quand le code est connu, jamais de HTML', () => {
    const table: Record<string, string> = {
      'replay.kinds.attempt_finished': 'Essai {n} : {execution}, {result}',
      'replay.kinds.unknown': 'Événement {kind}',
      'execution.fetch': 'Fetch seul',
    };
    const t = (key: string, named: Record<string, string> = {}) => (table[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => named[name] ?? '');
    const te = (key: string) => key in table;
    expect(describeReplayEvent(t, te, { id: '1', seq: 1, kind: 'attempt.finished', at: null, params: { n: 2, execution: 'fetch', result: '<img src=x onerror=alert(1)>' } })).toBe('Essai 2 : Fetch seul, <img src=x onerror=alert(1)>');
    expect(describeReplayEvent(t, te, { id: '1', seq: 1, kind: 'truc.inconnu', at: null, params: {} })).toBe('Événement truc.inconnu');
    expect(replayKindKey('Phase.Started')).toBe('replay.kinds.phase_started');
    expect(replayKindKey('a/../b')).toBe('replay.kinds.a____b');
  });
});

/** Les formats de nombre français emploient des espaces insécables : on les compare à des espaces ordinaires. */
const plain = (text: string | undefined): string => (text ?? '').replace(/[\u00a0\u202f]/g, ' ');

describe('formats et textes', () => {
  test('montants : « ~ » quand estimé, « — » quand inconnu (jamais 0 par défaut)', () => {
    expect(formatUsd(0.002, 'fr', true)).toBe('~0,002 $');
    expect(formatUsd(0.0024, 'en', true)).toBe('~0.0024 $');
    expect(plain(formatUsd(12.5, 'fr'))).toBe('12,5 $');
    expect(formatUsd(0, 'fr')).toBe('0,00 $');
    expect(formatUsd(null, 'fr')).toBe('—');
    expect(plain(formatPercent(0.97, 'fr'))).toBe('97 %');
    expect(formatPercent(null, 'fr')).toBe('—');
  });

  test('durées et dates relatives', () => {
    expect(formatDuration(250, 'fr')).toBe('250 ms');
    expect(formatDuration(1500, 'fr')).toBe('1,5 s');
    expect(formatDuration(90_000, 'en')).toBe('1.5 min');
    expect(formatDuration(null, 'fr')).toBe('—');
    const now = Date.parse('2026-10-01T10:00:00Z');
    expect(formatAgo('2026-10-01T08:00:00Z', 'fr', now)).toContain('2');
    expect(formatAgo('2026-10-01T09:59:40Z', 'en', now)).toBeTruthy();
    expect(formatAgo(null, 'fr', now)).toBe('—');
    expect(formatAgo('pas une date', 'fr', now)).toBe('—');
  });

  test('reasonParams : nombres et dates mis en forme selon la langue', () => {
    const params = reasonParams({ n: 1234.5, domain: 'a.example', date: '2026-10-01T08:00:00Z' }, 'fr');
    expect(plain(params.n)).toBe('1 234,5');
    expect(params.domain).toBe('a.example');
    expect(params.date).not.toBe('2026-10-01T08:00:00Z');
    expect(reasonParams({ date: 'pas une date' }, 'fr').date).toBe('pas une date');
    expect(reasonParams(undefined, 'fr')).toEqual({});
  });

  test('describeReason, describeReasonCode, describeFailureClass : code inconnu → phrase générique ou code', () => {
    const table: Record<string, string> = { 'reasons.retried': 'Réessayé {n} fois', 'statusDefault.sain': 'Propre', 'reasonLabel.retried': 'Essais répétés', 'failureClass.extraction': 'Extraction cassée', 'failureClass.llm': 'Modèle ({code})' };
    const t = (key: string, named: Record<string, string> = {}) => (table[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => named[name] ?? '');
    const te = (key: string) => key in table;
    expect(describeReason(t, te, 'fr', 'sain', { code: 'retried', params: { n: 3 } })).toBe('Réessayé 3 fois');
    expect(describeReason(t, te, 'fr', 'sain', { code: 'inconnu', params: {} })).toBe('Propre');
    expect(describeReason(t, te, 'fr', 'sain', null)).toBe('Propre');
    expect(describeReasonCode(t, te, 'retried')).toBe('Essais répétés');
    expect(describeReasonCode(t, te, 'x')).toBe('x');
    expect(describeFailureClass(t, te, 'extraction')).toBe('Extraction cassée');
    expect(describeFailureClass(t, te, 'llm_timeout')).toBe('Modèle (llm_timeout)');
    expect(describeFailureClass(t, te, 'autre')).toBe('autre');
  });

  test('causes d’action requise : un bouton par cause, aucune cause ne relance en boucle ni ne mène à un défi', () => {
    expect(actionCause('cookie_expired')?.primary).toEqual({ kind: 'route', to: '/settings/extension' });
    expect(actionCause('account_limit')?.primary).toBeNull();
    expect(actionCause('challenge_in_tunnel')).toMatchObject({ verified: false, primary: { kind: 'hash', hash: '#launch' } });
    expect(actionCause('blocked_by_protection')).toBeNull();
    expect(actionCause(undefined)).toBeNull();
  });

  test('safeHref : seuls http et https deviennent des liens', () => {
    expect(safeHref('https://a.example/x')).toBe('https://a.example/x');
    expect(safeHref('http://a.example/')).toBe('http://a.example/');
    for (const hostile of ['javascript:alert(1)', 'data:text/html,<b>', 'vbscript:x', 'ftp://a', '//a.example', 'pas une url', '', null, undefined]) expect(safeHref(hostile), String(hostile)).toBeNull();
  });

  test('describeCron : phrase dans la langue de la console, null pour une expression invalide ou vide', async () => {
    expect(await describeCron('0 8 * * *', 'en')).toContain('08:00');
    expect(await describeCron('0 8 * * *', 'fr')).toMatch(/08:00/);
    expect(await describeCron('pas un cron', 'en')).toBeNull();
    expect(await describeCron('  ', 'en')).toBeNull();
  });
});
