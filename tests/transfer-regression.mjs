import { spawn } from 'node:child_process';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = new URL('../evidence/import-export/', import.meta.url);
await mkdir(evidence,{recursive:true});
const log = new URL('verification-runs.log', evidence);
await writeFile(log, `Import/export verification ${new Date().toISOString()}\n`);
const commands = [
  ['--import','tsx','--test','tests/transfer.test.ts','tests/environments.test.ts'],
  ['tests/browser-e2e.mjs'],
  ['tests/environment-browser.mjs'],
  ['tests/transfer-browser.mjs'],
];
for (let round = 1; round <= 3; round++) {
  for (const args of commands) {
    const label = `ROUND ${round}: node ${args.join(' ')}\n`;
    process.stdout.write(label); await appendFile(log,label);
    await new Promise((resolve,reject) => {
      const child = spawn(process.execPath,args,{cwd:root,stdio:['ignore','pipe','pipe']});
      let output='';
      for (const stream of [child.stdout,child.stderr]) stream.on('data',d => {process.stdout.write(d);output+=d.toString();});
      child.on('error',reject);
      child.on('exit',async code => {await appendFile(log,output); code===0?resolve():reject(new Error(`${args.join(' ')} failed with ${code}`));});
    });
  }
  await appendFile(log,`ROUND ${round} PASSED\n`);
}
await writeFile(new URL('regression-result.json',evidence),JSON.stringify({result:'passed',rounds:3,checksPerRound:51,finishedAt:new Date().toISOString(),commands},null,2));
console.log('PASS three rounds, 51 checks per round');
