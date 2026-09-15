import { validateEnvironmentPackages } from './environment-package';
import { createExecutionBackend, normalizeExecutionDefinition, type ExecutionDefinition } from '../execution/configuration';
import type { ExecutionEnvironment } from '../execution/types';
import { opaqueId } from './identity';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve, parse } from 'node:path';
import { assertConfinedPath } from '../platform/confined-path';
import { isIP } from 'node:net';
import type { ModelEgressRule } from './egress';
import { SPACE_ENGINE_IDS, type SpaceEngineDeployment, type SpaceEngineId } from './engine-runtime';
import type { AccessMode } from '../config/permissions';
import type { SpacePaths } from './paths';
import { withConfinedLaunch } from './launch';
import { spawnProcessSync } from '../platform/spawn';

/** Host configuration. Environment values are resolved only at launch, never
 * saved in desired state, a public management plan or a migration receipt. */
export interface SpaceDeploymentDefinition {
  schema: 'aria.space.deployment.v1';
  engineId: SpaceEngineId;
  binary: string;
  binaryVersion: string;
  driver: 'trusted-process' | 'execution';
  execution?: ExecutionDefinition;
  queryNode?: string;
  tools?: SpaceEngineDeployment['tools'];
  environmentPackages?: SpaceEngineDeployment['environmentPackages'];
  modelEndpoints?: readonly ModelEgressRule[];
  /** Operator-admitted paths mounted read-only at the same path in workers. */
  readonlyResources?: readonly string[];
  workspaceAccess: AccessMode;
  executableRoots: readonly string[];
  environmentKeys: readonly string[];
  /** Explicit native configuration templates; never auth files or shell state. */
  templates: readonly { target: string; contents: string; sha256: string }[];
}

const templateTargets: Record<SpaceEngineId, readonly string[]> = {
  codex: ['home/.codex/config.toml'], grok: ['home/.grok/settings.json'],
  claude: ['home/.claude/settings.json'], opencode: ['config/opencode/opencode.json'],
  kimi: ['home/.kimi/config.toml'], pi: ['data/pi-sessions/settings.json'], dsh: ['home/.dsh/config.json'],
};
const forbiddenEnvironment = /^(?:HOME$|PATH$|XDG_|LARK|LARKSUITE|ARIA_|CODEX_HOME$|GROK_HOME$|DSH_HOME$|PI_CODING_AGENT_DIR$|CLAUDE_CONFIG_DIR$|OPENCODE_CONFIG_DIR$|LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$)/;

/**
 * Execution spaces provision POSIX process, path and socket state: a confined
 * native home, a space-owned unix-socket transport and a container driver.
 * A host without those primitives cannot run them, so say so here rather than
 * surfacing a bind or path error from deep inside a launch.
 */
export function assertSpaceHostSupported(): void {
  if (process.platform !== 'linux') throw new Error('execution spaces require a Linux host');
}

export function normalizeSpaceDeployment(value: unknown): SpaceDeploymentDefinition {
  assertSpaceHostSupported();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid space deployment');
  const v = value as SpaceDeploymentDefinition;
  if (v.schema !== 'aria.space.deployment.v1' || !SPACE_ENGINE_IDS.includes(v.engineId)
    || !isAbsolute(v.binary || '') || !v.binaryVersion?.trim() || v.binaryVersion.length > 128
    || !['trusted-process', 'execution'].includes(v.driver)
    || !['read-only', 'workspace', 'full'].includes(v.workspaceAccess)
    || !Array.isArray(v.executableRoots) || v.executableRoots.some((p) => typeof p !== 'string' || !isAbsolute(p))
    || !Array.isArray(v.environmentKeys) || new Set(v.environmentKeys).size !== v.environmentKeys.length
    || v.environmentKeys.some((k) => typeof k !== 'string' || !/^[A-Z][A-Z0-9_]{0,127}$/.test(k) || forbiddenEnvironment.test(k))
    || !Array.isArray(v.templates)) throw new Error('invalid space deployment');
  if (v.driver === 'execution') normalizeExecutionDefinition(v.execution);
  else if (v.execution !== undefined) throw new Error('execution configuration requires the execution driver');
  if (v.readonlyResources !== undefined && (v.driver !== 'execution'
    || !Array.isArray(v.readonlyResources) || v.readonlyResources.length > 32
    || new Set(v.readonlyResources).size !== v.readonlyResources.length
    || v.readonlyResources.some(p => typeof p !== 'string' || !isAbsolute(p) || resolve(p) !== p
      || p === parse(p).root || /[\n\r\0,:]/.test(p)))) throw new Error('invalid read-only execution resources');
  if (v.queryNode !== undefined && !isAbsolute(v.queryNode)) throw new Error('invalid query helper');
  if (v.tools !== undefined) {
    const t = v.tools?.larkCli;
    if (!t || !['trusted-process', 'execution'].includes(v.driver) || !v.queryNode || !isAbsolute(t.binary || '')
      || typeof t.binaryVersion !== 'string' || !t.binaryVersion.trim() || t.binaryVersion.length > 128
      || typeof t.userAuthorization !== 'boolean' || (v.driver === 'execution' && !t.userAuthorization) || Object.keys(v.tools).some(k => k !== 'larkCli')
      || Object.keys(t).some(k => !['binary', 'binaryVersion', 'userAuthorization'].includes(k))) throw new Error('invalid native tool deployment');
  }
  if (v.environmentPackages !== undefined) {
    if (v.driver !== 'execution') throw new Error('environment packages require container execution');
    validateEnvironmentPackages(v.environmentPackages);
  }
  if (v.modelEndpoints !== undefined && (!Array.isArray(v.modelEndpoints)
    || v.driver !== 'execution' || !v.queryNode || v.modelEndpoints.some((rule) =>
      !rule || typeof rule.hostname !== 'string' || isIP(rule.hostname) || !rule.hostname.includes('.')
      || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(rule.hostname) || rule.port !== 443))) {
    throw new Error('invalid model egress deployment');
  }
  if (new Set(v.templates.map((t) => t.target)).size !== v.templates.length) throw new Error('duplicate native template');
  for (const t of v.templates) {
    if (!templateTargets[v.engineId].includes(t.target) || typeof t.contents !== 'string' || t.contents.length > 1024 * 1024
      || digest(t.contents) !== t.sha256) throw new Error('invalid native template');
    // Provider keys belong in explicit environment bindings, not copied files.
    if (/\b(?:api_key|apiKey|access_token|refresh_token|password)\s*[=:]\s*["'][^"']+["']/i.test(t.contents)) {
      throw new Error('native templates cannot contain credential values');
    }
  }
  const keys = new Set(['schema', 'engineId', 'binary', 'binaryVersion', 'driver', 'execution', 'queryNode', 'tools', 'environmentPackages', 'modelEndpoints', 'readonlyResources', 'workspaceAccess', 'executableRoots', 'environmentKeys', 'templates']);
  if (Object.keys(v).some((key) => !keys.has(key))) throw new Error('unknown space deployment field');
  return structuredClone(v);
}

export function resolveSpaceDeployment(definition: SpaceDeploymentDefinition, env: NodeJS.ProcessEnv = process.env): SpaceEngineDeployment {
  const v = normalizeSpaceDeployment(definition);
  const environment: Record<string, string> = {};
  for (const key of v.environmentKeys) {
    const value = env[key];
    if (!value) throw new Error(`required deployment environment is unavailable: ${key}`);
    environment[key] = value;
  }
  return { engineId: v.engineId, binary: v.binary, binaryVersion: v.binaryVersion,
    ...(v.queryNode ? { queryNode: v.queryNode } : {}), ...(v.modelEndpoints ? { modelEndpoints: v.modelEndpoints } : {}),
    ...(v.tools ? { tools: v.tools } : {}),
    ...(v.environmentPackages ? { environmentPackages: v.environmentPackages } : {}),
    ...(v.readonlyResources ? { readonlyResources: v.readonlyResources } : {}),
    templates: v.templates,
    launch: { driver: v.driver, workspaceAccess: v.workspaceAccess, executableRoots: v.executableRoots, environment } };
}

/** No model request or caller credentials are needed to probe the selected driver. */
export async function probeSpaceDeployment(definition: SpaceDeploymentDefinition, paths: SpacePaths): Promise<void> {
  const d = normalizeSpaceDeployment(definition);
  let environment: ExecutionEnvironment | undefined;
  if (d.execution) {
    environment = await createExecutionBackend(d.execution).open({
      key: opaqueId('execution-probe', [paths.spaceId]), revision: d.binaryVersion,
      cwd: paths.workspace, workingRoots: [paths.engine],
      mounts: [{ source: paths.engine, target: paths.engine, writable: true }],
    });
  }
  try {
  const result = withConfinedLaunch({ ...d, paths, environment: {}, executableRoots: d.executableRoots,
    ...(environment ? { executionEnvironment: environment } : {}) },
    () => spawnProcessSync(d.binary, ['--version'], { cwd: paths.workspace, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 }));
  const version = String(result.stdout ?? '').trim();
  if (result.error || result.status !== 0 || !version.split(/\s+/).includes(d.binaryVersion)) {
    throw new Error('selected space driver or native binary version did not pass its startup probe');
  }
  if (d.tools) {
    // Version probes run on the host; only the tool adapter can later access
    // its newly prepared credential slots. Never bind or log in in a probe.
    const tool = spawnProcessSync(d.tools.larkCli.binary, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
    if (tool.error || tool.status !== 0 || !String(tool.stdout ?? '').trim().split(/\s+/).includes(d.tools.larkCli.binaryVersion)) {
      throw new Error('native tool binary version did not pass its startup probe');
    }
    const node = spawnProcessSync(d.queryNode!, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 });
    if (node.error || node.status !== 0 || !/^v(?:2[2-9]|[3-9][0-9])\./.test(String(node.stdout ?? '').trim())) throw new Error('native tool Node helper is unavailable');
  }
  } finally { await environment?.close(); }
}

export function deployedToolRevisions(tools: SpaceEngineDeployment['tools'], extensions: readonly { id: string; revision: string }[] = []): readonly { id: string; revision: string }[] {
  return [...(tools?.larkCli ? [{ id: 'lark-cli', revision: tools.larkCli.binaryVersion }] : []),
    ...extensions.map(t => ({ id: t.id, revision: t.revision }))];
}

export function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

/**
 * Read a private control file, rejecting a symlink at or below `root`.
 *
 * Callers pass the tightest boundary they own, which is the directory tree
 * they created and validated. The file's own directory is the default: it
 * still rejects a symlinked leaf alongside `O_NOFOLLOW` without inspecting
 * operator-owned ancestors, which are not part of any space.
 */
export async function readPrivateJson(path: string, root: string = dirname(resolve(path)), maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  const absolute = resolve(path);
  await assertConfinedPath(root, absolute);
  const file = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('invalid private space control file');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}
