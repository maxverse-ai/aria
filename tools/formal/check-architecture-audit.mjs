// Compatibility entry point for historical audit commands.
import { run, manifest } from './check.mjs';
run(manifest.groups.filter(group => group.id !== 'codex-resume').map(group => group.id), { verbose: true });
