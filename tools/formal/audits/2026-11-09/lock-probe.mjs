// Historical baseline evidence; uses synthetic data only. Run from repository root.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsup'))('esbuild');
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
await build({entryPoints:['src/platform/distribution/store.ts'],bundle:true,platform:'node',format:'esm',outfile:'scripts/audit-control/distribution-store.mjs',packages:'external'});
const {DistributionStore}=await import(pathToFileURL(path.resolve('scripts/audit-control/distribution-store.mjs')).href);
const root=path.resolve('scripts/audit-control/lock-data');await fsp.mkdir(root,{recursive:true});const lockFile=path.join(root,'update.lock');
await fsp.writeFile(lockFile,JSON.stringify({pid:2147483647,createdAt:'2000-01-01T00:00:00Z'}));
const originalRead=fsp.readFile;
let releaseSecondRead, markSecondRead, releaseFirst, releaseSecond;
const secondRead=new Promise(r=>markSecondRead=r);const secondMayContinue=new Promise(r=>releaseSecondRead=r);
const firstHold=new Promise(r=>releaseFirst=r);const secondHold=new Promise(r=>releaseSecond=r);
let lockReads=0;
fsp.readFile=async function(p,...args){const value=await originalRead(p,...args);if(String(p)===lockFile){lockReads++;if(lockReads===1){await secondRead;}else if(lockReads===2){markSecondRead();await secondMayContinue;}}return value;};syncBuiltinESMExports();
const store=new DistributionStore({root,lockFile});let active=0,maxActive=0;
const a=store.withLock(async()=>{active++;maxActive=Math.max(active,maxActive);releaseSecondRead();await firstHold;active--;});
const b=store.withLock(async()=>{active++;maxActive=Math.max(active,maxActive);releaseFirst();await secondHold;active--;});
await a;releaseSecond();await b;
fsp.readFile=originalRead;syncBuiltinESMExports();console.log(JSON.stringify({case:'stale-lock-takeover',maxConcurrentOwners:maxActive,expected:1}));
await fsp.writeFile(lockFile,'');let rejected=false;try{await store.withLock(async()=>{});}catch{rejected=true;}await fsp.rm(lockFile,{force:true});
console.log(JSON.stringify({case:'empty-lock-after-crash',rejectedDespiteNoOwner:rejected}));

assert.equal(maxActive,2); assert.equal(rejected,true);
