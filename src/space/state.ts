import { join } from 'node:path';
import { SessionCatalog } from '../session/catalog';
import { SessionStore } from '../session/store';
import { SessionResetStore } from '../session/reset-store';
import { WorkspaceStore } from '../workspace/store';
import { SpaceAuthorization, type AuthorizedSpaceContext } from './authorization';
import { assertConfinedPath, prepareSpacePaths, resolveSpacePaths, type SpacePaths } from './paths';

export interface SpaceStateView {
  readonly paths: SpacePaths;
  readonly sessions: SessionStore;
  readonly resets: SessionResetStore;
  readonly sessionCatalog: SessionCatalog;
  readonly workspaces: WorkspaceStore;
}
/** Reuses the existing stores; each space has a host-only physical state boundary. */
export class SpaceStateStore {
  private readonly states = new Map<string, Promise<SpaceStateView>>();
  constructor(private readonly profileDirectory: string, private readonly authorization: SpaceAuthorization) {}
  async view(context: AuthorizedSpaceContext): Promise<SpaceStateView> {
    const snapshot = this.authorization.inspect(context);
    const id = snapshot.binding.spaceId;
    let loaded = this.states.get(id);
    if (!loaded) {
      loaded = this.load(resolveSpacePaths(this.profileDirectory, snapshot.binding.key)).catch((error) => {
        this.states.delete(id); throw error;
      });
      this.states.set(id, loaded);
    }
    const stores = await loaded;
    this.authorization.inspect(context);
    const guard = <T extends object>(target: T): T => new Proxy(target, {
      get: (object, key) => {
        this.authorization.inspect(context);
        const value = Reflect.get(object, key);
        return typeof value === 'function' ? (...args: unknown[]) => {
          this.authorization.inspect(context);
          return value.apply(object, args);
        } : value;
      },
      set: () => { throw new Error('space store views are read-only handles'); },
    });
    return Object.freeze({ paths: stores.paths, sessions: guard(stores.sessions), resets: guard(stores.resets),
      sessionCatalog: guard(stores.sessionCatalog), workspaces: guard(stores.workspaces) });
  }
  async flush(): Promise<void> {
    const states = await Promise.all(this.states.values());
    await Promise.all(states.flatMap((state) => [state.sessions.flush(), state.resets.flush(), state.sessionCatalog.flush(), state.workspaces.flush()]));
  }
  private async load(paths: SpacePaths): Promise<SpaceStateView> {
    await prepareSpacePaths(paths);
    const file = async (name: string) => assertConfinedPath(paths.control, join(paths.control, name));
    const sessions = new SessionStore(await file('sessions.json'));
    const resets = new SessionResetStore(await file('session-resets.json'));
    const sessionCatalog = new SessionCatalog(await file('sessions.catalog.json'));
    const workspaces = new WorkspaceStore(await file('workspaces.json'));
    await Promise.all([sessions.load(), resets.load(), sessionCatalog.load(), workspaces.load()]);
    return Object.freeze({ paths, sessions, resets, sessionCatalog, workspaces });
  }
}
export interface ScopedNativeSession {
  readonly schema: 'aria.space.native-session.v1';
  readonly spaceId: string;
  readonly bindingRef: string;
  readonly engineId: string;
  readonly scopeRef: string;
  readonly nativeId: string;
}
export function assertNativeSession(reference: ScopedNativeSession, context: AuthorizedSpaceContext,
  authorization: SpaceAuthorization, engineId: string): void {
  const snapshot = authorization.inspect(context);
  if (reference.schema !== 'aria.space.native-session.v1' || reference.spaceId !== snapshot.binding.spaceId
    || reference.bindingRef !== snapshot.binding.ref || reference.scopeRef !== snapshot.scopeRef
    || reference.engineId !== engineId || !reference.nativeId) throw new Error('foreign native session reference');
}
