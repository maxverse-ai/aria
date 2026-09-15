const EXACT_FORBIDDEN_KEYS = new Set([
  'LARKSUITE_CLI_CONFIG_DIR',
  'ARIA_HOME',
  'ARIA_WORKSPACE_HOME',
  'ARIA_TRIGGER_RUNTIME',
]);

function isForbiddenKey(key: string): boolean {
  return key === 'LARK_CHANNEL'
    || key.startsWith('LARK_')
    || key.startsWith('LARKSUITE_')
    || key.startsWith('FEISHU_')
    || key.startsWith('ARIA_UI_')
    || EXACT_FORBIDDEN_KEYS.has(key);
}

/**
 * Fail closed when a managed worker inherits a channel or UI supervisor
 * environment. Chord workers must be channel-free processes with their own
 * config and state roots; accepting this environment could couple them to the
 * live Aria bridge that launched the parent process.
 */
export function assertIsolatedWorkerEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): void {
  const forbidden = Object.keys(env)
    .filter((key) => env[key] !== undefined && isForbiddenKey(key))
    .sort();
  if (forbidden.length === 0) return;

  // Report names only. Values can contain profile paths or credentials.
  throw new Error(
    `aria worker serve requires an isolated environment; remove: ${forbidden.join(', ')}`,
  );
}
