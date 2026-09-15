import type { AuthorizedSpaceContext } from '../space/authorization';

/** Per-run native presentation. Closing must synchronously revoke invocation
 * authority, including when native preparation or spawn fails. */
export interface RunToolLease { readonly prompt: string; close(): void }
export interface RunTools {
  prepare(context: AuthorizedSpaceContext, runId: string): Promise<RunToolLease | undefined>;
  /** Host-owned work still running after its initiating model turn ended. */
  activeWork?(): number;
  close(): Promise<void>;
}
