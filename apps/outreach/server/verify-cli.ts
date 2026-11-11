import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { verifyCandidates } from './grounding.js';
import type { CandidateDraft, EvidencePage, Rfq } from '../shared/types.js';

const input = resolve(process.argv[2] ?? '/mnt/archil/input');
const output = resolve(process.argv[3] ?? '/mnt/archil/output');
const [rfq, drafts, pages] = await Promise.all([
  readFile(`${input}/rfq.json`, 'utf8').then(value => JSON.parse(value) as Rfq),
  readFile(`${input}/candidate_drafts.json`, 'utf8').then(value => JSON.parse(value) as CandidateDraft[]),
  readFile(`${input}/raw_evidence.json`, 'utf8').then(value => JSON.parse(value) as EvidencePage[]),
]);
const result = verifyCandidates(drafts, pages, rfq);
await mkdir(output, { recursive: true });
const resultPath = `${output}/verified.json`;
await writeFile(resultPath, JSON.stringify(result, null, 2));
const handle = await open(resultPath, 'r+');
try { await handle.sync(); } finally { await handle.close(); }
console.log(JSON.stringify({ candidates: result.candidates.length, rejected: result.rejected.length, output: 'verified.json' }));
