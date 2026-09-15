import { describe, expect, it } from 'vitest';
import { createExecutionBackend, normalizeExecutionDefinition, type ExecutionDefinition } from '../../../src/execution/configuration';
import { normalizeSpaceDeployment, probeSpaceDeployment } from '../../../src/space/deployment';
import { resolveSpacePaths } from '../../../src/space/paths';

const definition: ExecutionDefinition = {
  schema: 'aria.execution.v1', backend: 'podman', managerEnvironmentKeys: ['HOME'],
  configuration: { binary: '/nonexistent/aria-test-podman', managerCwd: '/tmp',
    image: 'example/engine@sha256:' + 'a'.repeat(64), user: '1000:1000', network: 'none',
    memoryBytes: 268435456, cpus: 1, pids: 64, tmpBytes: 16777216 },
};
const deployment = {
  schema: 'aria.space.deployment.v1', engineId: 'codex', binary: '/bin/true', binaryVersion: '1',
  driver: 'execution', execution: definition, workspaceAccess: 'workspace', executableRoots: [], environmentKeys: [], templates: [],
};
describe('execution configuration boundary', () => {
  it('admits image-pinned local packages without installing a host tool transport', () => {
    const packages = [{id:'example-cli',revision:'1',module:'/opt/packages/example.mjs',sha256:'a'.repeat(64)}];
    expect(normalizeSpaceDeployment({...deployment,environmentPackages:packages}).environmentPackages).toEqual(packages);
    expect(normalizeSpaceDeployment({...deployment,environmentPackages:packages}).tools).toBeUndefined();
    expect(() => normalizeSpaceDeployment({...deployment,driver:'trusted-process',execution:undefined,environmentPackages:packages})).toThrow('container');
    expect(() => normalizeSpaceDeployment({...deployment,environmentPackages:[{...packages[0],sha256:'changed'}]})).toThrow();
  });

  it('accepts explicit bridge networking but rejects namespace sharing and arbitrary network arguments', () => {
    const connected = { ...definition, configuration: { ...definition.configuration, network: 'bridge' } };
    expect(normalizeExecutionDefinition(connected).configuration.network).toBe('bridge');
    for (const network of ['host', 'container:another-space', 'ns:/proc/1/ns/net', 'bridge,--privileged', '', null]) {
      expect(() => normalizeExecutionDefinition({ ...connected, configuration: { ...connected.configuration, network } })).toThrow();
    }
  });

  it('stores environment references only and rejects unknown or unsafe configuration', () => {
    expect(normalizeExecutionDefinition(definition)).toEqual(definition);
    expect(() => normalizeExecutionDefinition({ ...definition, backend: 'unknown' })).toThrow();
    expect(() => normalizeExecutionDefinition({ ...definition, configuration: { ...definition.configuration, privileged: true } })).toThrow();
    expect(() => normalizeExecutionDefinition({ ...definition, configuration: { ...definition.configuration, managerEnv: { TOKEN: 'secret' } } })).toThrow();
    expect(() => normalizeExecutionDefinition({ ...definition, managerEnvironmentKeys: ['HOME', 'LD_PRELOAD'] })).toThrow();
    expect(() => createExecutionBackend(definition, {})).toThrow('unavailable: HOME');
    expect(createExecutionBackend(definition, { HOME: '/private/runtime' }).id).toBe('podman');
  });
  it('requires explicit backend intent and personal business authorization', () => {
    expect(normalizeSpaceDeployment(deployment).driver).toBe('execution');
    expect(() => normalizeSpaceDeployment({ ...deployment, execution: undefined })).toThrow();
    expect(() => normalizeSpaceDeployment({ ...deployment, driver: 'trusted-process' })).toThrow();
    expect(() => normalizeSpaceDeployment({ ...deployment, queryNode: '/usr/bin/node', tools: {
      larkCli: { binary: '/usr/bin/lark-cli', binaryVersion: '1', userAuthorization: false },
    } })).toThrow('invalid native tool deployment');
  });
  it('fails a missing backend probe instead of executing the host engine', async () => {
    const paths = resolveSpacePaths('/tmp/aria-probe-fixture', { kind: 'default', profileId: 'fixture' });
    await expect(probeSpaceDeployment(normalizeSpaceDeployment(deployment), paths)).rejects.toThrow();
  });
});
