import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';
import { ChannelPluginError } from './errors';
import { ChannelPluginRegistry } from './registry';
import type {
  ChannelPlugin,
  ChannelPluginPackage,
  ResolvedChannelInstance,
} from './types';
import {
  assertCanonicalChannelPluginId,
  assertChannelPlugin,
  assertChannelPluginPackageName,
  assertChannelPluginPackageVersion,
  assertResolvedChannelInstance,
} from './validation';

export interface ExternalChannelPluginRequest {
  package: string;
  version: string;
}

/** Deployment-owned allowlist entry. Desired state alone never grants trust. */
export interface TrustedExternalChannelPlugin {
  package: string;
  version: string;
  pluginId: string;
}

export interface ExternalChannelPluginPackageMetadata {
  name: string;
  version: string;
}

export interface ResolvedExternalChannelPluginPackage {
  /** Opaque import target returned by the source after metadata-only resolution. */
  specifier: string;
  metadata: unknown;
}

/**
 * Resolution and import are separate so metadata and trust are checked before
 * executable package code runs. Tests can inject a deterministic local source.
 */
export interface ExternalChannelPluginPackageSource {
  resolve(packageName: string): Promise<ResolvedExternalChannelPluginPackage>;
  importModule(specifier: string): Promise<unknown>;
}

export interface LoadedExternalChannelPlugin {
  package: string;
  version: string;
  pluginId: string;
}

export interface ExternalChannelPluginLoaderOptions {
  registry: ChannelPluginRegistry;
  trustedPackages: readonly TrustedExternalChannelPlugin[];
  source?: ExternalChannelPluginPackageSource;
}

interface LoadedEntry extends LoadedExternalChannelPlugin {
  plugin: ChannelPlugin;
}

type CandidateEntry = LoadedEntry;

/** Resolves only packages already installed beside the running Aria package. */
export class InstalledChannelPluginPackageSource
  implements ExternalChannelPluginPackageSource
{
  async resolve(packageName: string): Promise<ResolvedExternalChannelPluginPackage> {
    try {
      return {
        specifier: packageName,
        metadata: await findInstalledPackageMetadata(packageName),
      };
    } catch (cause) {
      throw loaderError(
        `installed channel plugin package could not be resolved: ${packageName}`,
        'channel-plugin-package-resolution-failed',
        cause,
      );
    }
  }

  async importModule(specifier: string): Promise<unknown> {
    return import(specifier);
  }
}

/**
 * Transactional owner for external Channel Plugin ABI registrations.
 *
 * The loader never installs packages, starts provider connections, resolves
 * secrets, or edits profile configuration. A caller composes the registered
 * plugins with ChannelManager and unloads them after manager rollback/close.
 */
export class ExternalChannelPluginLoader {
  readonly registry: ChannelPluginRegistry;

  private readonly source: ExternalChannelPluginPackageSource;
  private readonly trustByPackage = new Map<string, TrustedExternalChannelPlugin>();
  private readonly trustByPluginId = new Map<string, TrustedExternalChannelPlugin>();
  private readonly loadedByPackage = new Map<string, LoadedEntry>();
  private readonly loadedByPluginId = new Map<string, LoadedEntry>();
  private readonly loadOrder: string[] = [];
  private loading = false;

  constructor(options: ExternalChannelPluginLoaderOptions) {
    this.registry = options.registry;
    this.source = options.source ?? new InstalledChannelPluginPackageSource();

    for (const value of options.trustedPackages) {
      const entry = normalizeTrustEntry(value);
      if (this.trustByPackage.has(entry.package)) {
        throw configurationError(
          `duplicate trusted channel plugin package: ${entry.package}`,
          'duplicate-channel-plugin-trust',
        );
      }
      if (this.trustByPluginId.has(entry.pluginId)) {
        throw configurationError(
          `duplicate trusted channel plugin id: ${entry.pluginId}`,
          'duplicate-channel-plugin-trust',
        );
      }
      this.trustByPackage.set(entry.package, entry);
      this.trustByPluginId.set(entry.pluginId, entry);
    }
  }

  list(): LoadedExternalChannelPlugin[] {
    return this.loadOrder.map((packageName) =>
      publicDescriptor(this.loadedByPackage.get(packageName)!),
    );
  }

  /** Deployment trust for one plugin id, independent of desired state. */
  trustFor(pluginId: string): TrustedExternalChannelPlugin | undefined {
    return this.trustByPluginId.get(pluginId);
  }

  /** Whether a package is already loaded through this loader. */
  isLoaded(packageName: string): boolean {
    return this.loadedByPackage.has(packageName);
  }

  /**
   * Resolve, verify, import, validate and register one batch atomically.
   * Matching stored instances are config-validated before registry mutation.
   */
  async load(
    requests: readonly ExternalChannelPluginRequest[],
    instances: readonly ResolvedChannelInstance[] = [],
  ): Promise<LoadedExternalChannelPlugin[]> {
    if (this.loading) {
      throw configurationError(
        'external channel plugin load is already in progress',
        'channel-plugin-loader-busy',
      );
    }
    this.loading = true;
    try {
      const desired = this.preflightRequests(requests);
      const candidates: CandidateEntry[] = [];

      for (const { request, trust } of desired) {
        let resolved: ResolvedExternalChannelPluginPackage;
        try {
          resolved = await this.source.resolve(request.package);
        } catch (cause) {
          if (cause instanceof ChannelPluginError) throw cause;
          throw loaderError(
            `installed channel plugin package could not be resolved: ${request.package}`,
            'channel-plugin-package-resolution-failed',
            cause,
          );
        }

        const metadata = normalizePackageMetadata(resolved.metadata, request.package);
        if (metadata.name !== request.package || metadata.version !== request.version) {
          throw configurationError(
            `installed channel plugin package does not match exact pin: ${request.package}@${request.version}`,
            'channel-plugin-package-version-mismatch',
          );
        }

        let moduleNamespace: unknown;
        try {
          moduleNamespace = await this.source.importModule(resolved.specifier);
        } catch (cause) {
          throw loaderError(
            `channel plugin package import failed: ${request.package}`,
            'channel-plugin-package-import-failed',
            cause,
          );
        }
        const plugin = extractChannelPlugin(moduleNamespace, request.package);
        if (
          plugin.manifest.package.name !== metadata.name ||
          plugin.manifest.package.version !== metadata.version
        ) {
          throw configurationError(
            `channel plugin manifest package identity does not match installed metadata: ${request.package}`,
            'channel-plugin-manifest-package-mismatch',
          );
        }
        if (plugin.manifest.id !== trust.pluginId) {
          throw configurationError(
            `channel plugin id does not match trusted identity: ${request.package}`,
            'channel-plugin-id-mismatch',
          );
        }
        candidates.push({
          package: request.package,
          version: request.version,
          pluginId: plugin.manifest.id,
          plugin,
        });
      }

      validateMatchingInstances(candidates, instances);
      this.registerBatch(candidates);
      return candidates.map(publicDescriptor);
    } finally {
      this.loading = false;
    }
  }

  /** Unregister one loader-owned package. Active runtimes fail closed. */
  unload(packageName: string): boolean {
    this.assertNotLoading();
    assertChannelPluginPackageName(packageName);
    const entry = this.loadedByPackage.get(packageName);
    if (!entry) return false;
    this.assertOwnership(entry);
    if (this.registry.inUseCount(entry.pluginId) > 0) {
      throw configurationError(
        `cannot unload active external channel plugin: ${entry.pluginId}`,
        'active-channel-plugin-unload-denied',
      );
    }
    if (!this.registry.unregister(entry.pluginId)) {
      throw configurationError(
        `external channel plugin registration disappeared: ${entry.pluginId}`,
        'channel-plugin-ownership-mismatch',
      );
    }
    this.forget(entry);
    return true;
  }

  /** Atomically preflights all owned plugins before unregistering in reverse order. */
  unloadAll(): LoadedExternalChannelPlugin[] {
    this.assertNotLoading();
    const entries = [...this.loadOrder]
      .reverse()
      .map((packageName) => this.loadedByPackage.get(packageName)!);
    for (const entry of entries) {
      this.assertOwnership(entry);
      if (this.registry.inUseCount(entry.pluginId) > 0) {
        throw configurationError(
          `cannot unload active external channel plugin: ${entry.pluginId}`,
          'active-channel-plugin-unload-denied',
        );
      }
    }
    for (const entry of entries) {
      if (!this.registry.unregister(entry.pluginId)) {
        throw configurationError(
          `external channel plugin registration disappeared: ${entry.pluginId}`,
          'channel-plugin-ownership-mismatch',
        );
      }
      this.forget(entry);
    }
    return entries.map(publicDescriptor);
  }

  private preflightRequests(requests: readonly ExternalChannelPluginRequest[]): Array<{
    request: ExternalChannelPluginRequest;
    trust: TrustedExternalChannelPlugin;
  }> {
    const seen = new Set<string>();
    return requests.map((value) => {
      const request = normalizeRequest(value);
      if (seen.has(request.package)) {
        throw configurationError(
          `duplicate desired channel plugin package: ${request.package}`,
          'duplicate-channel-plugin-package',
        );
      }
      seen.add(request.package);
      const trust = this.trustByPackage.get(request.package);
      if (!trust || trust.version !== request.version) {
        throw configurationError(
          `channel plugin package is not explicitly trusted at the exact version: ${request.package}@${request.version}`,
          'untrusted-channel-plugin-package',
        );
      }
      if (this.loadedByPackage.has(request.package)) {
        throw configurationError(
          `external channel plugin package is already loaded: ${request.package}`,
          'external-channel-plugin-already-loaded',
        );
      }
      if (this.loadedByPluginId.has(trust.pluginId)) {
        throw configurationError(
          `external channel plugin id is already loader-owned: ${trust.pluginId}`,
          'external-channel-plugin-already-loaded',
        );
      }
      if (this.registry.get(trust.pluginId)) {
        throw configurationError(
          `channel plugin id is already registered: ${trust.pluginId}`,
          'duplicate-channel-plugin-id',
        );
      }
      return { request, trust };
    });
  }

  private registerBatch(candidates: readonly CandidateEntry[]): void {
    const registered: CandidateEntry[] = [];
    try {
      for (const candidate of candidates) {
        this.registry.register(candidate.plugin);
        registered.push(candidate);
      }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const candidate of [...registered].reverse()) {
        try {
          if (
            this.registry.get(candidate.pluginId) === candidate.plugin &&
            !this.registry.unregister(candidate.pluginId)
          ) {
            throw new Error('registration disappeared during rollback');
          }
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [error, ...rollbackErrors],
          'external channel plugin registration failed and rollback was incomplete',
          { cause: error },
        );
      }
      throw error;
    }

    for (const candidate of candidates) {
      this.loadedByPackage.set(candidate.package, candidate);
      this.loadedByPluginId.set(candidate.pluginId, candidate);
      this.loadOrder.push(candidate.package);
    }
  }

  private assertOwnership(entry: LoadedEntry): void {
    if (
      this.loadedByPluginId.get(entry.pluginId) !== entry ||
      this.registry.get(entry.pluginId) !== entry.plugin
    ) {
      throw configurationError(
        `external channel plugin ownership mismatch: ${entry.pluginId}`,
        'channel-plugin-ownership-mismatch',
      );
    }
  }

  private assertNotLoading(): void {
    if (this.loading) {
      throw configurationError(
        'cannot unload external channel plugins while loading',
        'channel-plugin-loader-busy',
      );
    }
  }

  private forget(entry: LoadedEntry): void {
    this.loadedByPackage.delete(entry.package);
    this.loadedByPluginId.delete(entry.pluginId);
    const index = this.loadOrder.indexOf(entry.package);
    if (index >= 0) this.loadOrder.splice(index, 1);
  }
}

function normalizeRequest(value: ExternalChannelPluginRequest): ExternalChannelPluginRequest {
  if (!value || typeof value !== 'object') {
    throw configurationError(
      'external channel plugin request must be an object',
      'invalid-channel-plugin-load-request',
    );
  }
  assertChannelPluginPackageName(value.package);
  assertChannelPluginPackageVersion(value.version);
  return Object.freeze({ package: value.package, version: value.version });
}

function normalizeTrustEntry(
  value: TrustedExternalChannelPlugin,
): TrustedExternalChannelPlugin {
  if (!value || typeof value !== 'object') {
    throw configurationError(
      'trusted external channel plugin entry must be an object',
      'invalid-channel-plugin-trust',
    );
  }
  assertChannelPluginPackageName(value.package);
  assertChannelPluginPackageVersion(value.version);
  assertCanonicalChannelPluginId(value.pluginId);
  return Object.freeze({
    package: value.package,
    version: value.version,
    pluginId: value.pluginId,
  });
}

function normalizePackageMetadata(
  value: unknown,
  packageName: string,
): ExternalChannelPluginPackageMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationError(
      `invalid installed channel plugin package metadata: ${packageName}`,
      'invalid-channel-plugin-package-metadata',
    );
  }
  const metadata = value as { name?: unknown; version?: unknown };
  try {
    assertChannelPluginPackageName(metadata.name);
    assertChannelPluginPackageVersion(metadata.version);
  } catch (cause) {
    throw loaderError(
      `invalid installed channel plugin package metadata: ${packageName}`,
      'invalid-channel-plugin-package-metadata',
      cause,
    );
  }
  return { name: metadata.name, version: metadata.version };
}

function extractChannelPlugin(moduleNamespace: unknown, packageName: string): ChannelPlugin {
  if (!moduleNamespace || typeof moduleNamespace !== 'object') {
    throw configurationError(
      `channel plugin package does not export channelPluginPackage: ${packageName}`,
      'invalid-channel-plugin-package-export',
    );
  }
  const packageExport = (moduleNamespace as { channelPluginPackage?: unknown })
    .channelPluginPackage;
  if (!packageExport || typeof packageExport !== 'object') {
    throw configurationError(
      `channel plugin package does not export channelPluginPackage: ${packageName}`,
      'invalid-channel-plugin-package-export',
    );
  }
  const plugin = (packageExport as Partial<ChannelPluginPackage>).channelPlugin;
  try {
    assertChannelPlugin(plugin);
  } catch (cause) {
    throw loaderError(
      `channel plugin package exports an invalid Channel Plugin ABI: ${packageName}`,
      'invalid-channel-plugin-package-export',
      cause,
    );
  }
  return plugin;
}

function validateMatchingInstances(
  candidates: readonly CandidateEntry[],
  instances: readonly ResolvedChannelInstance[],
): void {
  const plugins = new Map(candidates.map((candidate) => [candidate.pluginId, candidate.plugin]));
  for (const instance of instances) {
    const plugin = plugins.get(instance.pluginId);
    if (!plugin) continue;
    try {
      assertResolvedChannelInstance(instance, plugin.manifest);
      const config = plugin.validateConfig(structuredClone(instance.config));
      assertResolvedChannelInstance({ ...instance, config }, plugin.manifest);
    } catch (cause) {
      throw loaderError(
        `channel instance config is incompatible with loaded plugin: ${instance.instanceId}`,
        'invalid-channel-plugin-config',
        cause,
      );
    }
  }
}

function publicDescriptor(entry: LoadedEntry): LoadedExternalChannelPlugin {
  return Object.freeze({
    package: entry.package,
    version: entry.version,
    pluginId: entry.pluginId,
  });
}

async function findInstalledPackageMetadata(
  packageName: string,
): Promise<ExternalChannelPluginPackageMetadata> {
  const require = createRequire(import.meta.url);
  const packageParts = packageName.split('/');
  for (const lookupPath of require.resolve.paths(packageName) ?? []) {
    try {
      return JSON.parse(
        await readFile(join(lookupPath, ...packageParts, 'package.json'), 'utf8'),
      ) as ExternalChannelPluginPackageMetadata;
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  // Fallback for nonstandard resolvers that expose an entry but not an ordinary
  // node_modules lookup root.
  let resolvedEntry: string;
  try {
    resolvedEntry = require.resolve(packageName);
  } catch (cause) {
    throw new Error('package entry and metadata not found', { cause });
  }
  let directory = dirname(resolvedEntry);
  const root = parse(directory).root;
  while (true) {
    try {
      const parsed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name !== undefined || parsed.version !== undefined) {
        return parsed as ExternalChannelPluginPackageMetadata;
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  throw new Error('package metadata not found');
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function configurationError(message: string, code: string): ChannelPluginError {
  return new ChannelPluginError(message, { kind: 'configuration', code });
}

function loaderError(message: string, code: string, cause?: unknown): ChannelPluginError {
  return new ChannelPluginError(message, { kind: 'configuration', code, cause });
}
