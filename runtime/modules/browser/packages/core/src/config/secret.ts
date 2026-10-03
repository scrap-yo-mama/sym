// SPDX-License-Identifier: AGPL-3.0-only
// Valeur secrète de la configuration : opaque dans toute sérialisation (JSON, `util.inspect`, gabarit), lisible par `reveal()` seul.
import { inspect } from 'node:util';

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return '[Secret]';
  }
  toString(): string {
    return '[Secret]';
  }
  [inspect.custom](): string {
    return '[Secret]';
  }
}
