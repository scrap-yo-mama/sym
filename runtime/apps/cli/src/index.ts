#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { run } from './cli.js';

const { code, out } = await run(process.argv.slice(2));
(code === 0 ? console.log : console.error)(out);
process.exitCode = code;
