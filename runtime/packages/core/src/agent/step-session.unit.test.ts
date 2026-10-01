// SPDX-License-Identifier: AGPL-3.0-only
// Suivi des instantanés et exécuteur `agent_step` (07 §3, tâche 0.6b), sans navigateur : un faux navigateur à références
// renumérotées à chaque changement montre qu'un `ref` périmé ne vise jamais un autre élément.
import { describe, expect, it } from 'vitest';
import { AgentStepExecutor, StepSnapshotTracker, hasRef, semanticOf, truncateTree, type AgentStepAction, type AgentStepDriver, type AgentStepResult, type StepExpectedTarget, type StepObservation } from '../index.js';

/** Page factice : une liste d'éléments ; `ref` = rang courant (e1, e2…), donc renumérotés quand la liste change. */
class FakePage implements AgentStepDriver {
  url = 'https://monsite.com/';
  items: { role: string; name: string }[] = [
    { role: 'button', name: 'Archiver' },
    { role: 'button', name: 'Supprimer tout' },
    { role: 'button', name: 'Envoyer' },
  ];
  performed: string[] = [];
  challenge = false;
  /** Appelé entre la vérification de fraîcheur et l'action : simule un changement de page dans cet intervalle. */
  beforePerform: (() => void) | undefined;
  observed = 0;

  async observe(): Promise<StepObservation> {
    this.observed += 1;
    return { url: this.url, tree: this.items.map((item, i) => `- ${item.role} "${item.name}" [ref=e${i + 1}]`).join('\n') };
  }
  async perform(action: Parameters<AgentStepDriver['perform']>[0], expected?: { role: string; name: string }): ReturnType<AgentStepDriver['perform']> {
    this.beforePerform?.();
    if (action.kind === 'click' || action.kind === 'type') {
      const index = Number(action.target.ref.slice(1)) - 1;
      const item = this.items[index];
      // Le pilote vérifie que le ref désigne toujours l'élément vu : sinon, refus sans exécuter.
      if (item === undefined || item.role !== expected?.role || item.name !== expected.name) return { ok: false, error: 'stale_ref' };
      this.performed.push(`${action.kind}:${item.name}`);
      if (item.name === 'Archiver') this.items.splice(index, 1);
      return { ok: true };
    }
    if (action.kind === 'navigate') {
      this.url = action.url;
      this.performed.push(`navigate:${action.url}`);
      return { ok: true };
    }
    if (action.kind === 'scroll') this.performed.push(`scroll:${action.direction}`);
    return { ok: true };
  }
  classify(action: Parameters<NonNullable<AgentStepDriver['classify']>>[0], target: { role: string; name: string } | undefined): 'read' | 'write' {
    return action.kind === 'click' && target?.name === 'Envoyer' ? 'write' : 'read';
  }
  challengeDetected(): boolean {
    return this.challenge;
  }
}

const make = (page: AgentStepDriver, options: { allowWriteActions?: boolean } = {}): AgentStepExecutor =>
  new AgentStepExecutor({ driver: page, urlAllowed: (url) => new URL(url).hostname === 'monsite.com', allowWriteActions: options.allowWriteActions ?? false });

const ok = (result: AgentStepResult) => {
  if (!result.ok) throw new Error(`refus inattendu : ${result.error}`);
  return result.snapshot;
};

describe('arbre : fonctions pures', () => {
  const tree = '- main\n  - button "Suivant" [ref=e7]\n  - link "Aide \\"?\\"" [ref=e9]';
  it('hasRef et semanticOf', () => {
    expect(hasRef(tree, 'e7')).toBe(true);
    expect(hasRef(tree, 'e8')).toBe(false);
    expect(hasRef(tree, 'e7]; x')).toBe(false);
    expect(semanticOf(tree, 'e7')).toEqual({ role: 'button', name: 'Suivant' });
    expect(semanticOf(tree, 'e9')).toEqual({ role: 'link', name: 'Aide "?"' });
    expect(semanticOf(tree, 'e1')).toBeUndefined();
  });
  it('truncateTree coupe sur une fin de ligne et le dit', () => {
    expect(truncateTree('a\nb', 10)).toEqual({ text: 'a\nb', truncated: false });
    expect(truncateTree('aaaa\nbbbb\ncccc', 7)).toEqual({ text: 'aaaa\n- [truncated]', truncated: true });
  });
});

describe('StepSnapshotTracker', () => {
  it('une page inchangée garde son snapshot_id ; un changement en émet un nouveau', () => {
    const tracker = new StepSnapshotTracker();
    const a = tracker.observe({ url: 'https://monsite.com/', tree: '- button "A" [ref=e1]' });
    const same = tracker.observe({ url: 'https://monsite.com/', tree: '- button "A" [ref=e1]' });
    const other = tracker.observe({ url: 'https://monsite.com/', tree: '- button "B" [ref=e1]' });
    expect(same.snapshotId).toBe(a.snapshotId);
    expect(other.snapshotId).not.toBe(a.snapshotId);
    expect(a.snapshotId).toMatch(/^s\d+-[0-9a-f]{6}$/);
  });

  it('un changement d\'URL seul rend l\'ancien instantané périmé', () => {
    const tracker = new StepSnapshotTracker();
    const first = tracker.observe({ url: 'https://monsite.com/a', tree: '- button "A" [ref=e1]' });
    const verdict = tracker.verify({ snapshotId: first.snapshotId, ref: 'e1' }, { url: 'https://monsite.com/b', tree: '- button "A" [ref=e1]' });
    expect(verdict.ok).toBe(false);
  });

  it('un snapshot_id inconnu est périmé', () => {
    const tracker = new StepSnapshotTracker();
    tracker.observe({ url: 'https://monsite.com/', tree: '- button "A" [ref=e1]' });
    expect(tracker.verify({ snapshotId: 's999-000000', ref: 'e1' }, { url: 'https://monsite.com/', tree: '- button "A" [ref=e1]' }).ok).toBe(false);
  });

  it('l\'arbre rendu est tronqué, l\'arbre complet sert à retrouver rôle et nom', () => {
    const tracker = new StepSnapshotTracker({ maxTreeChars: 30 });
    const tree = '- button "A" [ref=e1]\n- button "B" [ref=e2]\n- button "C" [ref=e3]';
    const snap = tracker.observe({ url: 'https://monsite.com/', tree });
    expect(snap.truncated).toBe(true);
    expect(snap.accessibilityTree.length).toBeLessThan(tree.length);
    expect(tracker.semanticTarget(snap.snapshotId, 'e3')).toEqual({ role: 'button', name: 'C' });
  });
});

describe('assert_agent_step_stale_ref : AgentStepExecutor (07 §3)', () => {
  it('stale_ref : la liste a changé, le ref périmé vise maintenant un autre bouton ; erreur typée, rien n\'est exécuté, nouvel instantané rendu', async () => {
    const page = new FakePage();
    const exec = make(page);
    const first = ok(await exec.executeAction({ kind: 'read' }));
    // e2 = « Supprimer tout » dans cet instantané ; on archive e1, la liste se renumérote : e2 devient « Envoyer ».
    expect(semanticOf(first.accessibilityTree, 'e2')).toEqual({ role: 'button', name: 'Supprimer tout' });
    ok(await exec.executeAction({ kind: 'click', target: { snapshotId: first.snapshotId, ref: 'e1' } }));
    expect(page.performed).toEqual(['click:Archiver']);
    const stale = await exec.executeAction({ kind: 'click', target: { snapshotId: first.snapshotId, ref: 'e2' } });
    expect(stale).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(stale.snapshot?.snapshotId).not.toBe(first.snapshotId);
    expect(stale.snapshot?.accessibilityTree).toContain('button "Envoyer" [ref=e2]');
    // Jamais d'action sur l'élément qui occupe maintenant e2.
    expect(page.performed).toEqual(['click:Archiver']);
  });

  it('stale_ref aussi pour type et scroll, et pour un ref qui n\'existe plus', async () => {
    const page = new FakePage();
    const exec = make(page);
    const first = ok(await exec.executeAction({ kind: 'read' }));
    page.items.pop();
    expect(await exec.executeAction({ kind: 'type', target: { snapshotId: first.snapshotId, ref: 'e1' }, text: 'x' })).toMatchObject({ ok: false, error: 'stale_ref' });
    const second = ok(await exec.executeAction({ kind: 'read' }));
    page.items.push({ role: 'button', name: 'Nouveau' });
    expect(await exec.executeAction({ kind: 'scroll', snapshotId: second.snapshotId, direction: 'down' })).toMatchObject({ ok: false, error: 'stale_ref' });
    const third = ok(await exec.executeAction({ kind: 'read' }));
    expect(await exec.executeAction({ kind: 'click', target: { snapshotId: third.snapshotId, ref: 'e99' } })).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(page.performed).toEqual([]);
  });

  it('changement de page entre la vérification et l\'action : le pilote refuse, stale_ref, rien d\'exécuté', async () => {
    const page = new FakePage();
    const exec = make(page);
    const first = ok(await exec.executeAction({ kind: 'read' }));
    page.beforePerform = () => {
      page.items.shift();
    };
    const result = await exec.executeAction({ kind: 'click', target: { snapshotId: first.snapshotId, ref: 'e1' } });
    expect(result).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(page.performed).toEqual([]);
    expect(result.snapshot?.accessibilityTree).not.toContain('Archiver');
  });

  it('snapshot_id correct et page inchangée : l\'action part', async () => {
    const page = new FakePage();
    const exec = make(page);
    const first = ok(await exec.executeAction({ kind: 'read' }));
    ok(await exec.executeAction({ kind: 'scroll', snapshotId: first.snapshotId, direction: 'down' }));
    expect(page.performed).toEqual(['scroll:down']);
  });
});

describe('AgentStepExecutor : refus typés', () => {
  it('navigation hors liste : domain_not_allowed, le pilote n\'est pas appelé', async () => {
    const page = new FakePage();
    const result = await make(page).executeAction({ kind: 'navigate', url: 'https://evil.example/collect' });
    expect(result).toMatchObject({ ok: false, error: 'domain_not_allowed' });
    expect(page.performed).toEqual([]);
  });

  it('clic sur un bouton d\'envoi sans allow_write_actions : write_action_not_allowed ; autorisé, il part', async () => {
    const page = new FakePage();
    const strict = make(page);
    const snap = ok(await strict.executeAction({ kind: 'read' }));
    const refused = await strict.executeAction({ kind: 'click', target: { snapshotId: snap.snapshotId, ref: 'e3' } });
    expect(refused).toMatchObject({ ok: false, error: 'write_action_not_allowed' });
    expect(page.performed).toEqual([]);
    const allowed = make(page, { allowWriteActions: true });
    const snap2 = ok(await allowed.executeAction({ kind: 'read' }));
    ok(await allowed.executeAction({ kind: 'click', target: { snapshotId: snap2.snapshotId, ref: 'e3' } }));
    expect(page.performed).toEqual(['click:Envoyer']);
  });

  it('commande hors du jeu fermé (fil) : method_not_allowed, rien n\'est évalué ni observé', async () => {
    const page = new FakePage();
    const wire = await make(page).execute({ action: 'evaluate', expression: 'document.cookie' });
    expect(wire).toMatchObject({ ok: false, error: 'method_not_allowed', snapshot_id: null });
    expect(page.performed).toEqual([]);
    expect(page.observed).toBe(0);
  });

  it('défi détecté : challenge_in_tunnel, puis 0 commande envoyée au pilote', async () => {
    const page = new FakePage();
    const exec = make(page);
    const first = ok(await exec.executeAction({ kind: 'read' }));
    page.challenge = true;
    const hit = await exec.executeAction({ kind: 'scroll', snapshotId: first.snapshotId, direction: 'down' });
    expect(hit).toMatchObject({ ok: false, error: 'challenge_detected' });
    expect(hit.snapshot).toBeUndefined();
    const observedBefore = page.observed;
    const performedBefore = page.performed.length;
    for (const action of [{ kind: 'read' }, { kind: 'navigate', url: 'https://monsite.com/x' }] as const) {
      expect(await exec.executeAction(action)).toMatchObject({ ok: false, error: 'challenge_detected' });
    }
    expect(page.observed).toBe(observedBefore);
    expect(page.performed.length).toBe(performedBefore);
  });

  it('execute() parle le fil : args bruts en entrée, réponse du fil en sortie', async () => {
    const page = new FakePage();
    const exec = make(page);
    const read = await exec.execute({ action: 'read' });
    expect(read.ok).toBe(true);
    const stale = await exec.execute({ action: 'click', ref: 'e1', snapshot_id: 's404-000000' });
    expect(stale).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(stale.snapshot?.tree).toContain('Archiver');
  });
});

/**
 * Pilote « aveugle » : il exécute tout ce qu'on lui demande, sans vérifier `expected`. La règle de fraîcheur
 * (`snapshot_id` + empreinte) doit tenir seule, quel que soit le pilote CDP branché en 2.7.
 */
class BlindPage implements AgentStepDriver {
  url = 'https://monsite.com/';
  lines = ['- button "Archiver" [ref=e1]', '- button "Supprimer tout" [ref=e2]', '- button "Envoyer" [ref=e3]'];
  performed: string[] = [];
  classified: (StepExpectedTarget | undefined)[] = [];
  async observe(): Promise<StepObservation> {
    return { url: this.url, tree: this.lines.join('\n') };
  }
  async perform(action: AgentStepAction): ReturnType<AgentStepDriver['perform']> {
    this.performed.push(action.kind === 'click' || action.kind === 'type' ? `${action.kind}:${action.target.ref}` : action.kind);
    return { ok: true };
  }
  classify(_action: AgentStepAction, target: StepExpectedTarget | undefined): 'read' | 'write' {
    this.classified.push(target);
    return 'read';
  }
}

describe('assert_agent_step_stale_ref : la règle tient sans l\'aide du pilote', () => {
  it('click et type sur un ancien snapshot_id : stale_ref, nouvel instantané, rien n\'atteint un pilote qui ne vérifie rien', async () => {
    const page = new BlindPage();
    const exec = make(page);
    const first = ok(await exec.executeAction({ kind: 'read' }));
    page.lines.shift();
    const click = await exec.executeAction({ kind: 'click', target: { snapshotId: first.snapshotId, ref: 'e1' } });
    expect(click).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(click.snapshot?.snapshotId).not.toBe(first.snapshotId);
    const type = await exec.executeAction({ kind: 'type', target: { snapshotId: first.snapshotId, ref: 'e2' }, text: 'x' });
    expect(type).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(await exec.executeAction({ kind: 'click', target: { snapshotId: 's404-000000', ref: 'e1' } })).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(page.performed).toEqual([]);
    // Le contrôle positif : l'instantané frais fait partir l'action, donc le refus vient bien de la règle.
    const fresh = click.snapshot!;
    ok(await exec.executeAction({ kind: 'click', target: { snapshotId: fresh.snapshotId, ref: 'e2' } }));
    expect(page.performed).toEqual(['click:e2']);
  });

  it('ref présent mais ligne illisible (rôle ni nom) : stale_ref, rien d\'exécuté ni classé sans cible', async () => {
    const page = new BlindPage();
    page.lines = ['- 123 [ref=e1]'];
    const exec = make(page);
    const first = ok(await exec.executeAction({ kind: 'read' }));
    expect(await exec.executeAction({ kind: 'click', target: { snapshotId: first.snapshotId, ref: 'e1' } })).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(await exec.executeAction({ kind: 'type', target: { snapshotId: first.snapshotId, ref: 'e1' }, text: 'x' })).toMatchObject({ ok: false, error: 'stale_ref' });
    expect(page.performed).toEqual([]);
    expect(page.classified).toEqual([]);
  });
});

describe('semanticOf : clés YAML entre guillemets simples (format Playwright)', () => {
  it('un nom avec « : » est cité par Playwright ; rôle et nom sont relus, `\'\'` compris', () => {
    const tree = "- main:\n  - 'button \"Prix : 10 €\" [ref=e1]'\n  - 'link \"L''aide : FAQ\" [ref=e2] [cursor=pointer]':\n    - /url: /aide";
    expect(semanticOf(tree, 'e1')).toEqual({ role: 'button', name: 'Prix : 10 €' });
    expect(semanticOf(tree, 'e2')).toEqual({ role: 'link', name: "L'aide : FAQ" });
  });

  it('l\'exécuteur passe la cible relue au classifieur : un bouton d\'envoi cité reste une écriture', async () => {
    const page = new FakePage();
    page.items = [{ role: 'button', name: 'Envoyer : confirmer' }];
    const quoted = new (class extends FakePage {
      override async observe(): Promise<StepObservation> {
        this.observed += 1;
        return { url: this.url, tree: this.items.map((item, i) => `- '${item.role} "${item.name}" [ref=e${i + 1}]'`).join('\n') };
      }
      override classify(action: AgentStepAction, target: StepExpectedTarget | undefined): 'read' | 'write' {
        return action.kind === 'click' && target?.name.startsWith('Envoyer') === true ? 'write' : 'read';
      }
    })();
    quoted.items = page.items;
    const exec = make(quoted);
    const snap = ok(await exec.executeAction({ kind: 'read' }));
    expect(await exec.executeAction({ kind: 'click', target: { snapshotId: snap.snapshotId, ref: 'e1' } })).toMatchObject({ ok: false, error: 'write_action_not_allowed' });
    expect(quoted.performed).toEqual([]);
  });
});

describe('garde d\'écriture : fermé par défaut', () => {
  it('pilote sans classify et allow_write_actions faux : click et type sont des écritures, rien ne part ; autorisés, ils partent', async () => {
    const blind = new BlindPage();
    const driver = { observe: () => blind.observe(), perform: (a: AgentStepAction) => blind.perform(a) } as unknown as AgentStepDriver;
    const strict = new AgentStepExecutor({ driver, urlAllowed: () => true, allowWriteActions: false });
    const snap = ok(await strict.executeAction({ kind: 'read' }));
    expect(await strict.executeAction({ kind: 'click', target: { snapshotId: snap.snapshotId, ref: 'e1' } })).toMatchObject({ ok: false, error: 'write_action_not_allowed' });
    expect(await strict.executeAction({ kind: 'type', target: { snapshotId: snap.snapshotId, ref: 'e1' }, text: 'x' })).toMatchObject({ ok: false, error: 'write_action_not_allowed' });
    ok(await strict.executeAction({ kind: 'scroll', snapshotId: snap.snapshotId, direction: 'down' }));
    expect(blind.performed).toEqual(['scroll']);
    const open = new AgentStepExecutor({ driver, urlAllowed: () => true, allowWriteActions: true });
    const snap2 = ok(await open.executeAction({ kind: 'read' }));
    ok(await open.executeAction({ kind: 'click', target: { snapshotId: snap2.snapshotId, ref: 'e1' } }));
    expect(blind.performed).toEqual(['scroll', 'click:e1']);
  });
});
