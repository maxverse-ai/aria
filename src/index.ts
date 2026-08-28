// Public exports for consumers that need the same rendering logic the bot uses.
export { renderCard } from './card/run-renderer';
export { renderText } from './card/text-renderer';
export {
  initialState,
  createRunState,
  reduce,
  finalizeIfRunning,
  markInterrupted,
} from './card/run-state';
export type { RunState, ToolEntry, Block, ToolStatus, Terminal, FooterStatus } from './card/run-state';
export type { RunStatusSeed, RunStatusState } from './run-status/types';
export type { RunStatusItem, RunStatusItemId } from './run-status/items';
export { renderRunStatusLine } from './run-status/render';

// Optional telemetry hook (see README "Optional telemetry"). Types let an
// external adapter package implement the interface via `import type`; the
// runtime helpers are noop unless LARK_CHANNEL_TELEMETRY_MODULE is set.
export type {
  TelemetryAdapter,
  AdapterFactory,
  AdapterMeta,
  TelemetryEvent,
} from './core/telemetry';
export { reportMetric, reportError } from './core/logger';

// Stable, transport-neutral read-model contracts for control-plane consumers.
// Implementations remain internal and must not mutate agent-native stores.
export {
  NATIVE_AUDIT_ACTIONS,
  NATIVE_READ_API_VERSION,
  NATIVE_READ_RESOURCE_TYPES,
  NATIVE_READ_ROUTES,
} from './application/control/native-read-types';
export type {
  NativeAuditAction,
  NativeAuditActor,
  NativeAuditEventResource,
  NativeAuditTarget,
  NativeChatMemberResource,
  NativeChatResource,
  NativeIdentityResource,
  NativeMessageContent,
  NativeMessageResource,
  NativeProfileResource,
  NativeReadCapabilitiesResponse,
  NativeReadCapability,
  NativeReadChange,
  NativeReadChangesResponse,
  NativeReadCursor,
  NativeReadDetailResponse,
  NativeReadErrorCode,
  NativeReadErrorResponse,
  NativeReadHealthResponse,
  NativeReadListResponse,
  NativeReadMetaResponse,
  NativeReadResolutionStatus,
  NativeReadResource,
  NativeReadResourceBase,
  NativeReadResourceType,
  NativeRunResource,
  NativeSessionResource,
} from './application/control/native-read-types';

// Stable type surface for external engine plugins. Runtime orchestration stays
// internal; plugin packages only implement these contracts.
export type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from './agent/types';
export type {
  EngineRuntime,
  EngineStatusSnapshot,
  EngineUsageWindow,
} from './agent/runtime/types';
export type {
  EnginePlugin,
  EnginePluginContext,
  EnginePluginPackage,
  EngineProbe,
  EngineHistoryEntry,
} from './agent/plugin/types';

// Channel plugins translate protocol-specific ingress/egress around one
// channel-neutral conversation runtime. Deployments own plugin composition.
export { ConversationRuntime } from './conversation/runtime';
export type {
  ConversationRuntimeDeps,
  RecordConversationEventInput,
  StartConversationInput,
} from './conversation/runtime';
export { createProfileConversationHost } from './conversation/profile-host';
export type {
  CreateProfileConversationHostOptions,
  ProfileConversationHost,
  ProfileTextConversationInput,
  ProfileTextConversationResult,
} from './conversation/profile-host';
export type { ConversationSource } from './conversation/types';
export { ChannelPluginRegistry } from './channel/plugin/registry';
export type {
  ChannelCapabilities,
  ChannelConversationPort,
  ChannelIngressMode,
  ChannelMessageKind,
  ChannelPlugin,
  ChannelPluginContext,
  ChannelPluginPackage,
  ChannelRuntime,
  ChannelRuntimeSnapshot,
  ChannelStreamingMode,
} from './channel/plugin/types';
export { WechatKfCallbackHandler } from './channel/wechat-kf/callback';
export type {
  WechatKfCallbackHandlerOptions,
  WechatKfCallbackRequest,
  WechatKfCallbackResponse,
} from './channel/wechat-kf/callback';
export { WechatKfApiClient, WechatKfApiError } from './channel/wechat-kf/client';
export type {
  WechatKfAccessTokenProvider,
  WechatKfApiClientOptions,
  WechatKfFetch,
} from './channel/wechat-kf/client';
export { WechatKfCrypto } from './channel/wechat-kf/crypto';
export type { WechatKfCryptoOptions } from './channel/wechat-kf/crypto';
export { FileWechatKfCursorStore } from './channel/wechat-kf/cursor-store';
export type {
  FileWechatKfCursorStoreOptions,
  WechatKfCursorStore,
} from './channel/wechat-kf/cursor-store';
export { startWechatKfCallbackServer } from './channel/wechat-kf/http-server';
export type {
  WechatKfCallbackServerHandle,
  WechatKfCallbackServerOptions,
} from './channel/wechat-kf/http-server';
export { FileWechatKfNotificationInbox } from './channel/wechat-kf/inbox';
export type { FileWechatKfNotificationInboxOptions } from './channel/wechat-kf/inbox';
export { WechatKfNotificationProcessor } from './channel/wechat-kf/processor';
export type {
  WechatKfMessageSink,
  WechatKfNotificationProcessorOptions,
} from './channel/wechat-kf/processor';
export { wechatKfActorId, wechatKfScopeId } from './channel/wechat-kf/session';
export type {
  WechatKfMessage,
  WechatKfNotification,
  WechatKfNotificationSink,
  WechatKfSendTextInput,
  WechatKfSendTextResult,
  WechatKfSyncMessagesInput,
  WechatKfSyncMessagesResult,
} from './channel/wechat-kf/types';

// Stable outbound contracts. Aria itself is pass-through; deployments may
// observe or govern these envelopes without patching the channel SDK.
export { OutboundBroker } from './outbound/broker';
export {
  activeOutboundContext,
  activeOutboundIntent,
  withOutboundContext,
  withOutboundIntent,
} from './outbound/context';
export { createLarkOutboundGateway } from './outbound/lark-gateway';
export {
  loadOutboundPolicy,
  outboundPolicyStatus,
  OUTBOUND_POLICY_API_VERSION,
  OUTBOUND_POLICY_MODULE_ENV,
  OUTBOUND_POLICY_REQUIRED_ENV,
  REQUIRED_EXCLUDED_OUTBOUND_SINKS,
  REQUIRED_OUTBOUND_SINKS,
} from './outbound/plugin';
export type {
  OutboundContext,
  OutboundEnvelope,
  OutboundIntent,
  OutboundSink,
  OutboundSource,
} from './outbound/types';
export type {
  LoadedOutboundPolicy,
  LoadOutboundPolicyInput,
  OutboundPolicyContext,
  OutboundPolicyMeta,
  OutboundPolicyPlugin,
  OutboundPolicyStatus,
} from './outbound/plugin';

// Native read runtime is opt-in: importing these contracts does not start a
// socket or change any agent-native session storage.
export {
  DefaultNativeReadProfileRuntime,
  type NativeReadProfileRuntime,
  type NativeReadProfileRuntimeOptions,
} from './runtime/native-read-runtime';
export type { NativeReadScope } from './platform/native-read-http-server';
export type { RunAuditEvent, RunAuditSink } from './runtime/run-executor';
export type { GovernanceAuditAction, GovernanceAuditEvent, GovernanceAuditSink } from './runtime/governance-audit';
export type { MessageAuditEvent, MessageAuditSink } from './runtime/message-audit';
export type { MessageResourceEvent, MessageResourceSink, MessageSessionBinding } from './runtime/message-resource';
