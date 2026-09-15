import { spawnProcessSync } from '../platform/spawn';
import type { EngineHistoryEntry } from '../agent/plugin/types';
import { withConfinedLaunch, type ConfinedLaunch } from './launch';
import { within } from './paths';

/** Parse native files inside the same OS boundary as the engine, including symlinks. */
export function confinedClaudeHistory(launch: ConfinedLaunch, node: string, cwd: string, limit: number): EngineHistoryEntry[] {
  if (!within(launch.paths.workspace, cwd)) throw new Error('history cwd is outside its space');
  const max = Math.max(1, Math.min(100, limit));
  const result = withConfinedLaunch({ ...launch, binary: node }, () => spawnProcessSync(node,
    ['--max-old-space-size=64', '-e', READER, launch.paths.home, cwd, String(max)], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 2 * 1024 * 1024, cwd: launch.paths.workspace,
    }));
  if (result.status !== 0) throw new Error('confined native history reader failed');
  const entries: unknown = JSON.parse(String(result.stdout));
  if (!Array.isArray(entries) || entries.length > max || entries.some((entry) => !entry || typeof entry.id !== 'string'
    || typeof entry.preview !== 'string' || !Number.isFinite(entry.updatedAtMs))) throw new Error('invalid native history output');
  return entries;
}
const READER = `const fs=require('node:fs'), path=require('node:path');
const [home,cwd,limit]=process.argv.slice(1);
const root=path.join(home,'.claude','projects',cwd.replace(/[^A-Za-z0-9]/g,'-'));
let files=[]; try { files=fs.readdirSync(root); } catch(e) { if(e.code!=='ENOENT') throw e; }
const entries=files.filter(f=>f.endsWith('.jsonl')).map(f=>{
  try {const p=path.join(root,f), s=fs.statSync(p); return s.isFile()?{id:f.slice(0,-6),p,updatedAtMs:s.mtimeMs}:null;} catch{return null;}
}).filter(Boolean).sort((a,b)=>b.updatedAtMs-a.updatedAtMs).slice(0,Number(limit)).map(e=>{
  const fd=fs.openSync(e.p,'r'); let text; try {const b=Buffer.alloc(262144);text=b.subarray(0,fs.readSync(fd,b,0,b.length,0)).toString('utf8');}finally{fs.closeSync(fd);}
  let preview=''; for(const line of text.split('\\n')) {try{const row=JSON.parse(line);if(row.type==='user' && typeof row.message?.content==='string'){preview=row.message.content.slice(0,1000);break;}}catch{}}
  return {id:e.id,preview:preview||'(空会话)',updatedAtMs:e.updatedAtMs,detail:'Claude'};
});
process.stdout.write(JSON.stringify(entries));`;
