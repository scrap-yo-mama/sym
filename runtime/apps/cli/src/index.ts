#!/usr/bin/env node
import { run } from './cli.js';

const { code, out } = await run(process.argv.slice(2));
(code === 0 ? console.log : console.error)(out);
process.exitCode = code;
