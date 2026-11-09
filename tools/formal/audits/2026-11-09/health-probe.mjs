// Historical baseline evidence; uses synthetic data only. Run from repository root.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve('tsup'))('esbuild');
await (await import('node:fs/promises')).mkdir('scripts/audit-control',{recursive:true});
await build({entryPoints:['src/platform/distribution/service-orchestrator.ts'],bundle:true,platform:'node',format:'esm',outfile:'scripts/audit-control/orchestrator.mjs',packages:'external'});
const {OsServiceOrchestrator}=await import(pathToFileURL(process.cwd() + '/scripts/audit-control/orchestrator.mjs').href);
const adapter={stop:()=>({ok:true}),waitUntilStopped:async()=>true,start:()=>({ok:true}),isRunning:()=>true};
await new OsServiceOrchestrator('unused',()=>adapter).restartAndCheck([{serviceId:'synthetic',kind:'profile-service',profiles:['synthetic'],running:true}],'999.0.0');
console.log(JSON.stringify({case:'health-without-version',acceptedUnverifiedVersion:true}));
