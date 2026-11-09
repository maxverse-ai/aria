// Historical baseline evidence; uses synthetic data only. Run from repository root.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsup'))('esbuild');
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
await build({entryPoints:['src/config/keystore.ts'],bundle:true,platform:'node',format:'esm',outfile:'scripts/audit-control/keystore.mjs',packages:'external'});
const {setSecret,getSecret,listSecretIds,clearKeystoreDerivedKeyCache}=await import(pathToFileURL(path.resolve('scripts/audit-control/keystore.mjs')).href);
const root=await fsp.mkdtemp(path.resolve('scripts/audit-control/keystore-'));
const p={secretsFile:path.join(root,'secrets.enc'),keystoreSaltFile:path.join(root,'.salt')};
await fsp.writeFile(p.keystoreSaltFile,Buffer.alloc(32,7));await setSecret('baseline','synthetic-value',p);
const originalRead=fsp.readFile;let reads=0,release;const both=new Promise(r=>release=r);
fsp.readFile=async function(file,...args){const result=await originalRead(file,...args);if(String(file)===p.secretsFile){if(++reads===2)release();await both;}return result;};syncBuiltinESMExports();
await Promise.all([setSecret('a','synthetic-a',p),setSecret('b','synthetic-b',p)]);
fsp.readFile=originalRead;syncBuiltinESMExports();const ids=await listSecretIds(p);console.log(JSON.stringify({case:'deterministic-rmw',expectedEntries:3,actualEntries:ids.length,lostEntries:3-ids.length}));

assert.equal(ids.length,2);

await fsp.rm(root,{recursive:true,force:true});
