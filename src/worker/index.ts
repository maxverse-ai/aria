// Composition API only: the embedding process owns streams, signals and logging.
export { AriaWorkerServer } from './server';
export type { AriaWorkerServerOptions } from './server';
export { assertIsolatedWorkerEnvironment } from './isolation';
export {
  DEFAULT_WORKER_PRODUCT_IDENTITY,
  resolveWorkerProductIdentity,
} from './identity';
export type { WorkerProductIdentity, WorkerImplementationIdentity } from './identity';
export {
  ARIA_WORKER_PROTOCOL_VERSION,
  ARIA_WORKER_METHODS,
  WorkerProtocolError,
} from './protocol';
export type {
  AriaWorkerMethod,
  JsonRpcRequest,
  JsonRpcSuccess,
  JsonRpcFailure,
  JsonRpcNotification,
  WorkerHandshakeResult,
  WorkerHealthResult,
  RunStartParams,
  RunAcceptedResult,
  WorkerRunEvent,
  WorkerRunCompleted,
  WorkerRunFailed,
} from './protocol';
