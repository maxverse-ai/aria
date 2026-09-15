/** Aria owns the caller's identity and CLI installation. Lark owns business
 * parameters and resource permissions. Keep the distinction at this boundary;
 * a resource named "token", "app-id" or "config" is not a credential override.
 * See docs/LARK_CLI_ARGUMENT_POLICY.md for the audited CLI contract. */
export interface LarkCliArguments {
  argv: string[];
  identity: 'auto' | 'bot' | 'user';
  kind: 'business' | 'inspection' | 'authorization';
  command: string[];
}

const businessRoots = new Set([
  'api', 'application', 'approval', 'apps', 'attendance', 'base', 'calendar',
  'contact', 'docs', 'drive', 'event', 'im', 'mail', 'markdown', 'mindnotes', 'minutes',
  'note', 'okr', 'sheets', 'slides', 'task', 'vc', 'whiteboard', 'wiki',
]);
const managementRoots = new Set(['config', 'profile', 'update', 'doctor', 'login', 'logout']);
// The audited CLI's only global configuration selector is --profile. Other
// names (token, config, app-id, source...) belong to the selected command;
// they do not select host credentials. Do not recreate a keyword blacklist.
// --as is separately extracted and then supplied by the credential owner.

/** A value beginning with '-' must not be interpreted as another operation.
 * These are string-valued CLI fields, never switches. Unknown options are
 * forwarded without guessing their arity; use --option=value for an otherwise
 * ambiguous dash-prefixed value. CLI validation remains authoritative. */
const valueOptions = new Set([
  'as', 'format', 'jq', 'token', 'app-id', 'config', 'content', 'text', 'title',
  'name', 'description', 'message', 'body', 'query', 'keyword', 'data', 'params',
  'scope', 'domain', 'device-code', 'doc', 'url', 'file', 'output', 'output-dir',
  'file-name', 'input', 'path', 'whiteboard-token', 'param',
]);
const prefixSwitches = new Set(['json', 'dry-run', 'help', 'version']);
const prefixValues = new Set(['as', 'format', 'jq']);
const word = /^[a-z][a-z0-9_.-]*$/;
const commandWord = /^\+?[a-z][a-z0-9_.-]*$/;

export class LarkCliArgumentError extends Error {
  constructor(readonly code: 'invalid-arguments' | 'management-required' | 'unsupported-command', detail: string) {
    super(`[lark-cli:${code}] ${detail}. Rejected locally before a Feishu request; OAuth cannot repair this argument-policy error.`);
    this.name = 'LarkCliArgumentError';
  }
}
function invalid(detail: string): never { throw new LarkCliArgumentError('invalid-arguments', detail); }
function managed(detail: string): never { throw new LarkCliArgumentError('management-required', `Lark management operation required for ${detail}`); }

/** Parse identity selection once at ingress, and validate again at the provider
 * without allowing another selector. Never inspect substrings inside values. */
export function parseLarkCliArguments(input: readonly string[], allowIdentity = true): LarkCliArguments {
  if (!Array.isArray(input) || input.length > 512 || input.some(arg => typeof arg !== 'string' || arg.includes('\0') || arg.length > 256 * 1024)) {
    invalid('invalid argv');
  }
  const args = [...input];
  const prefix: string[] = [];
  while (args[0]?.startsWith('-') && args[0] !== '--') {
    const arg = args.shift()!;
    const name = arg === '-h' ? 'help' : arg === '-v' ? 'version' : arg.slice(2).split('=')[0]!;
    if (arg !== '-h' && arg !== '-v' && !arg.startsWith('--')) invalid('put the command before its business options');
    if (name === 'profile') managed('option --profile');
    if (!prefixSwitches.has(name) && !prefixValues.has(name)) invalid('put the command before its business options');
    prefix.push(arg === '-h' ? '--help' : arg === '-v' ? '--version' : arg);
    if (prefixValues.has(name) && !arg.includes('=')) {
      if (!args.length) invalid(`missing value for --${name}`);
      prefix.push(args.shift()!);
    }
  }
  if (!args.length) {
    const onlyHelp = prefix.length === 0 || prefix.every(arg => arg === '--help');
    if (onlyHelp) return { argv: ['--help'], identity: 'auto', kind: 'inspection', command: [] };
    if (prefix.length === 1 && prefix[0] === '--version') return { argv: ['--version'], identity: 'auto', kind: 'inspection', command: [] };
    invalid('a command is required');
  }
  const root = args[0]!;
  if (!word.test(root)) invalid('invalid command name');
  const command = [root];
  if (root === 'skills' || root === 'auth') {
    if (args[1] && commandWord.test(args[1])) command.push(args[1]);
  } else if (businessRoots.has(root) && root !== 'api') {
    // Shortcuts have one action; typed APIs have a resource and method.
    if (args[1] && commandWord.test(args[1])) {
      command.push(args[1]);
      if (!args[1].startsWith('+') && args[2] && commandWord.test(args[2])) command.push(args[2]);
    }
  }
  const tail = [...prefix, ...args.slice(command.length)];
  let identity: LarkCliArguments['identity'] = 'auto';
  let help = root === 'help';
  const forwarded: string[] = [...command];
  for (let i = 0; i < tail.length; i++) {
    const arg = tail[i]!;
    if (arg === '--') { forwarded.push(...tail.slice(i)); break; }
    if (!arg.startsWith('--')) {
      if (arg === '-h') help = true;
      // Known short string options also consume their operands, including '-'.
      if (arg === '-q' || arg === '-o' || (root === 'event' && arg === '-p')) {
        if (tail[i + 1] === undefined) invalid(`missing value for ${arg}`);
        const name = arg === '-q' ? 'jq' : arg === '-o' ? 'output' : 'param';
        forwarded.push(`--${name}=${tail[++i]}`);
      } else forwarded.push(arg);
      continue;
    }
    const equal = arg.indexOf('=');
    const name = arg.slice(2, equal < 0 ? undefined : equal);
    let value = equal < 0 ? undefined : arg.slice(equal + 1);
    if (name === 'as') {
      if (!allowIdentity) managed('an identity selector at the provider boundary');
      if (identity !== 'auto') invalid('duplicate --as');
      value ??= tail[++i];
      if (value !== 'bot' && value !== 'user') invalid('--as must be bot or user');
      identity = value;
      continue;
    }
    if (name === 'profile') managed('option --profile');
    if (name === 'help') {
      if (value !== undefined && value !== 'true' && value !== 'false') invalid('--help must be a boolean');
      if (value !== 'false') help = true;
    }
    if (valueOptions.has(name) && value === undefined) {
      if (tail[i + 1] === undefined) invalid(`missing value for --${name}`);
      value = tail[++i]!;
    }
    forwarded.push(value === undefined ? arg : `--${name}=${value}`);
  }
  const commandOnly = forwarded.length === command.length;
  if (help || (commandOnly && command.length === 1 && (businessRoots.has(root) || ['auth', 'skills'].includes(root)))) {
    // Do not forward a management invocation with a help switch: construct an
    // actual help operation, so no flag order can turn it into a mutation.
    const path = root === 'help' ? forwarded.slice(1).filter(arg => arg !== '--help' && arg !== '-h') : command;
    if (path.some(part => !commandWord.test(part))) invalid('help accepts only command names');
    return { argv: path.length ? ['help', ...path] : ['--help'], identity: 'auto', kind: 'inspection', command: ['help', ...path] };
  }
  if (managementRoots.has(root)) managed(`command ${root}`);
  if (root === 'auth' || root === 'whoami') return { argv: forwarded, identity, kind: 'authorization', command };
  if (root === 'schema' || (root === 'skills' && ['list', 'read'].includes(command[1] ?? ''))) {
    return { argv: forwarded, identity: 'auto', kind: 'inspection', command };
  }
  if (root === 'event' && ['list', 'schema'].includes(command[1] ?? '')) {
    return { argv: forwarded, identity: 'auto', kind: 'inspection', command };
  }
  if (root === 'event' && command[1] !== 'consume') managed('event daemon management');
  if (!businessRoots.has(root)) throw new LarkCliArgumentError('unsupported-command', `Command ${root} is not a declared business or inspection operation`);
  return { argv: forwarded, identity, kind: 'business', command };
}

export function providerLarkCliArguments(input: readonly string[], identity: 'bot' | 'user'): LarkCliArguments {
  const parsed = parseLarkCliArguments(input, false);
  if (parsed.kind === 'authorization') managed(`command ${parsed.command.join(' ')}`);
  if (parsed.kind === 'business') {
    // A caller's '--' terminates option parsing. Put the host-owned selector
    // before it; never let positional data disable the final identity choice.
    const marker = parsed.argv.indexOf('--');
    parsed.argv.splice(marker < 0 ? parsed.argv.length : marker, 0, '--as', identity);
  }
  return parsed;
}
