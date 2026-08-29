import { userInfo } from 'node:os';
import type { ControlActorContext } from '../application/control';

export function localCliActor(rootDir: string): ControlActorContext {
  const currentUser = userInfo();
  return {
    source: 'local-cli',
    principal: `${process.platform}:${currentUser.uid}:${currentUser.username}:${rootDir}`,
  };
}
