// SPDX-License-Identifier: AGPL-3.0-only
// SPIKE plan B (08 §3, tâche 1.5) : moteur QuickJS-wasm dans le même processus enfant, mêmes ponts, même amorce.
// Pas de production : dépendances en devDependencies, jamais le défaut sans mesures (QuickJS pré-1.0, non audité).
// Chargé dynamiquement par child.ts quand `engine = 'quickjs'`. Voir README.md § Spike QuickJS.
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSHandle,
  type QuickJSSyncVariant,
} from 'quickjs-emscripten-core';
import variantModule from '@jitl/quickjs-wasmfile-release-sync';
import type { ChildRunner, RunnerFactory } from './child.js';

// Interop CJS/ESM : la condition `import` rend la variante, les types décrivent le module CJS ({ default }).
const variant = ((variantModule as { default?: unknown }).default ?? variantModule) as QuickJSSyncVariant;

export const quickjsRunner: RunnerFactory = async (msg, send, guest) => {
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = quickjs.newRuntime();
  // Plafonds stricts au niveau de l'allocateur et de l'interpréteur (pas de JIT).
  runtime.setMemoryLimit(msg.limits.memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + msg.limits.timeoutMs));
  // Tout import (`import()`, même masqué par eval ou rattrapé) passe par ce chargeur : violation, aucun module chargé.
  runtime.setModuleLoader((name) => {
    send('violation', 0, 'forbidden_import', String(name).slice(0, 64));
    return { error: new Error('import interdit dans le bac à sable') };
  });
  const vm = runtime.newContext();
  const pump = () => {
    const jobs = runtime.executePendingJobs();
    if (jobs.error !== undefined) jobs.error.dispose();
  };

  const sendFn = vm.newFunction('send', (...handles: QuickJSHandle[]) => {
    const [kind, id, a, b] = handles.map((h) => vm.dump(h) as unknown);
    send(kind, id, a, b);
  });
  const boot = vm.unwrapResult(vm.evalCode(guest.bootstrap));
  const input = vm.newString(msg.inputJson);
  const settleFn = vm.unwrapResult(vm.callFunction(boot, vm.undefined, sendFn, input));
  input.dispose();
  boot.dispose();
  sendFn.dispose();

  let lastError: unknown;
  const runner: ChildRunner = {
    async run(code) {
      const promise = vm.unwrapResult(vm.evalCode(guest.wrap(code)));
      const settled = vm.resolvePromise(promise);
      promise.dispose();
      pump();
      const result = await settled;
      if (result.error !== undefined) {
        lastError = vm.dump(result.error);
        result.error.dispose();
        const e = lastError as { name?: string; message?: string } | undefined;
        throw new Error(`${e?.name ?? 'Error'}: ${e?.message ?? String(lastError)}`);
      }
      const out = vm.getString(result.value);
      result.value.dispose();
      return out;
    },
    settle(id, ok, payload) {
      const args = [vm.newNumber(id), ok ? vm.true : vm.false, vm.newString(payload)];
      const r = vm.callFunction(settleFn, vm.undefined, ...args);
      if (r.error !== undefined) r.error.dispose();
      else r.value.dispose();
      pump();
    },
    classify(error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/out of memory|string too long|allocation failed/i.test(message)) return 'memory';
      if (/interrupted/i.test(message)) return 'timeout';
      return 'script_error';
    },
  };
  return runner;
};
