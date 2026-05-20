#!/usr/bin/env node
/**
 * Contract consistency check.
 *
 * The TypeScript types live at `shared/contracts/agent-protocol.ts` (and
 * the matching C# at `shared/contracts/AgentProtocol.cs`). The JSON
 * Schema at `shared/contracts/agent-protocol.json` is the wire-format
 * source of truth used for runtime AJV validation in the server.
 *
 * This script:
 *   1. Validates the JSON Schema is itself a valid Draft-07 schema.
 *   2. Asserts every `MessageType` enum value in the schema is present
 *      in the hand-written TS union (and vice versa) so the typed view
 *      can't silently drift.
 *
 * Run with: npm run codegen:contracts (from server/)
 */
import { promises as fs } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');
const SCHEMA_DIR = resolve(REPO_ROOT, 'shared', 'contracts');

const errors = [];

async function readJson(name) {
  const path = resolve(SCHEMA_DIR, name);
  const text = await fs.readFile(path, 'utf8');
  return JSON.parse(text);
}

async function readText(name) {
  const path = resolve(SCHEMA_DIR, name);
  return fs.readFile(path, 'utf8');
}

function extractTsUnion(source, typeName) {
  // Naive but sufficient: `export type MessageType = | 'a' | 'b' | 'c';`
  const re = new RegExp(`export type ${typeName} =([^;]+);`, 'm');
  const m = source.match(re);
  if (!m) return null;
  const body = m[1];
  return [...body.matchAll(/'([^']+)'/g)].map((r) => r[1]).sort();
}

async function main() {
  const Ajv = (await import('ajv')).default;

  console.log('[contracts] validating agent-protocol.json against Draft-07...');
  const schema = await readJson('agent-protocol.json');
  const ajv = new Ajv({ strict: false, allErrors: true });
  try {
    ajv.compile(schema);
    console.log('[contracts]   OK');
  } catch (err) {
    errors.push(`agent-protocol.json invalid: ${err.message}`);
  }

  console.log('[contracts] cross-checking TS MessageType union vs schema enum...');
  const tsSrc = await readText('agent-protocol.ts');
  const tsUnion = extractTsUnion(tsSrc, 'MessageType');
  if (!tsUnion) {
    errors.push('failed to extract MessageType union from agent-protocol.ts');
  } else {
    const schemaEnum = [...schema.definitions.MessageType.enum].sort();
    const onlyInTs     = tsUnion.filter((v) => !schemaEnum.includes(v));
    const onlyInSchema = schemaEnum.filter((v) => !tsUnion.includes(v));
    if (onlyInTs.length || onlyInSchema.length) {
      errors.push(`MessageType drift between TS and JSON Schema:
  only in TS:     ${onlyInTs.join(', ') || '<none>'}
  only in schema: ${onlyInSchema.join(', ') || '<none>'}`);
    } else {
      console.log(`[contracts]   OK (${tsUnion.length} message types)`);
    }
  }

  console.log('[contracts] validating job-status.json against Draft-07...');
  const jobStatus = await readJson('job-status.json');
  try {
    ajv.compile(jobStatus);
    console.log('[contracts]   OK');
  } catch (err) {
    errors.push(`job-status.json invalid: ${err.message}`);
  }

  if (errors.length) {
    console.error('\n[contracts] FAILED:');
    for (const e of errors) console.error(' - ' + e);
    process.exit(1);
  }
  console.log('\n[contracts] all checks passed');
}

main().catch((err) => { console.error(err); process.exit(1); });
