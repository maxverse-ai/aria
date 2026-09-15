import { readPrivateJson, normalizeSpaceDeployment } from '../../space/deployment';
import { SpaceManagementService } from '../../space/management';
import { normalizeExecutionSpaceSelection } from '../../config/execution-spaces';
import { paths } from '../../config/paths';
import { loadRootConfig } from '../../config/profile-store';
import { resolveAppPaths } from '../../config/app-paths';
import { localCliActor } from '../control-actor';

export interface SpaceCliOptions { profile?: string; rootDir?: string; json?: boolean; id?: string; acceptSealedHistory?: boolean }
export async function runSpaceCommand(command: 'status' | 'prepare' | 'prepare-upgrade' | 'inspect' | 'activate' | 'rollback', file: string | undefined,
  options: SpaceCliOptions = {}): Promise<void> {
  const rootDir = options.rootDir ?? paths.rootDir;
  const actor = localCliActor(rootDir);
  const profile = options.profile ?? (await loadRootConfig(resolveAppPaths({ rootDir }).configFile))?.activeProfile;
  if (!profile) throw new Error('profile is required');
  const service = new SpaceManagementService({ rootDir,
    authorize: (candidate) => candidate.source === actor.source && candidate.principal === actor.principal });
  let result;
  if (command === 'prepare' || command === 'prepare-upgrade') {
    if (!file) throw new Error('private deployment file is required');
    const definition = normalizeSpaceDeployment(await readPrivateJson(file));
    result = command === 'prepare-upgrade' ? await service.prepareUpgrade(profile, definition, actor, options.id)
      : await service.prepare(profile, definition, actor, options.id);
  } else if (command === 'activate' || command === 'inspect') {
    if (!file) throw new Error('private selection file is required');
    const selection = normalizeExecutionSpaceSelection(await readPrivateJson(file));
    if (!selection) throw new Error('preparation selection is required');
    result = command === 'inspect' ? await service.inspectPreparation(profile, selection, actor)
      : await service.activate(profile, selection, actor, options.acceptSealedHistory);
  } else result = await service[command](profile, actor);
  console.log(JSON.stringify(result, null, options.json ? undefined : 2));
}
