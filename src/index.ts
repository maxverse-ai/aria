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

// Versioned execution-intent boundary shared by channels and future triggers.
export {
  RUN_INTENT_CONTRACT_VERSION,
  TRIGGER_CONTROL_API_VERSION,
  ExecutionIntentContractError,
  assertResultRoute,
  assertRunIntent,
  assertSessionPolicy,
  createConversationRunIntent,
  triggerCapabilities,
  triggerContractSchema,
} from './application/execution-intent';

// Trigger providers observe external/time events and submit serializable
// envelopes. Core alone resolves definitions, permissions and agent execution.
export {
  TRIGGER_PROVIDER_ABI_VERSION,
  TriggerProviderError,
  TriggerProviderRegistry,
  assertCanonicalTriggerProviderId,
  assertResolvedTriggerInstance,
  assertTriggerDrainOptions,
  assertTriggerDrainResult,
  assertTriggerEnvelope,
  assertTriggerHealthSnapshot,
  assertTriggerIngressAcceptance,
  assertTriggerInstanceRef,
  assertTriggerProvider,
  assertTriggerProviderManifest,
  assertTriggerRuntime,
  assertTriggerRuntimeSnapshot,
  runTriggerProviderContract,
  triggerRuntimeKey,
} from './trigger/plugin';

export {
  DEFAULT_TRIGGER_RETRY_POLICY,
  FILE_TRIGGER_STATE_VERSION,
  FileTriggerStateStore,
  InMemoryTriggerStateStore,
  TRIGGER_STATE_SCHEMA_VERSION,
  TriggerStateError,
  assertDefinitionTransition,
  assertRunIntentTemplate,
  assertTriggerDefinition,
  assertTriggerFailure,
  assertTriggerOccurrence,
  assertTriggerRetryPolicy,
  createPendingOccurrence,
  triggerOccurrenceIdempotencyKey,
  triggerRetryDelay,
} from './trigger/state';

export {
  TriggerManager,
  createTriggerRunIntent,
} from './trigger/runtime';
export type {
  TriggerExecutionGateway,
  TriggerExecutionResult,
  TriggerExecutionSubmission,
  TriggerExecutionTerminal,
  TriggerManagerOptions,
  TriggerManagerSnapshot,
} from './trigger/runtime';
export type {
  RunIntentTemplate,
  TriggerAuthorizationCeiling,
  TriggerClaimInput,
  TriggerCleanupInput,
  TriggerDefinition,
  TriggerDefinitionFilter,
  TriggerDefinitionState,
  TriggerDispatchCheckpoint,
  TriggerFailureKind,
  TriggerFailureRecord,
  TriggerLeaseRef,
  TriggerMaterializationInput,
  TriggerMaterializationResult,
  TriggerOccurrence,
  TriggerOccurrenceFilter,
  TriggerOccurrenceLease,
  TriggerOccurrenceState,
  TriggerQuotaPolicy,
  TriggerRetryInput,
  TriggerRetryPolicy,
  TriggerScheduleAdvanceInput,
  TriggerStateSnapshot,
  TriggerStateStore,
} from './trigger/state';

export {
  ScheduleContractError,
  addLocalDays,
  addLocalMinutes,
  assertScheduleSpec,
  assertTimeZone,
  cronMatches,
  decideOverlap,
  localDateTimeToInstant,
  materializeDueTimes,
  nextScheduleFire,
  parseConstrainedCron,
  previewSchedule,
  zonedDateTime,
} from './trigger/schedule';
export type {
  DueMaterialization,
  LocalDateTime,
  MisfirePolicy,
  OverlapDecision,
  OverlapDecisionInput,
  OverlapPolicy,
  ParsedCron,
  ScheduleSpec,
  WallClockTime,
} from './trigger/schedule';
export type {
  ResolvedTriggerInstance,
  TriggerActorEvidence,
  TriggerDrainOptions,
  TriggerDrainResult,
  TriggerEnvelope,
  TriggerHealthSnapshot,
  TriggerIngressAcceptance,
  TriggerIngressMode,
  TriggerIngressPort,
  TriggerInstanceRef,
  TriggerProvider,
  TriggerProviderCapabilities,
  TriggerProviderConfig,
  TriggerProviderContext,
  TriggerProviderErrorKind,
  TriggerProviderErrorOptions,
  TriggerProviderManifest,
  TriggerProviderPackage,
  TriggerReplayMode,
  TriggerRuntime,
  TriggerRuntimeSnapshot,
  TriggerRuntimeState,
  TriggerSourceKind,
} from './trigger/plugin';
export type {
  EngineCapabilityRequirements,
  EngineInputRequirement,
  ResultRoute,
  RunIntent,
  RunIntentActor,
  RunIntentCorrelation,
  RunIntentSourceIdentity,
  RunIntentSourceKind,
  SessionPolicy,
  TriggerCapabilitySnapshot,
  TriggerContractSchemaName,
  TriggerContractSchemaSnapshot,
  ValidatedAttachmentReference,
  WorkspaceReference,
} from './application/execution-intent';

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
  DefineEngineRuntimeDescriptorInput,
  EngineControlFeature,
  EngineInputKind,
  EngineInteractionFeature,
  EngineLiveInputMode,
  EngineRuntime,
  EngineRuntimeCapabilities,
  EngineRuntimeDescriptor,
  EngineRuntimeTopology,
  EngineSessionFeature,
  EngineStatusSnapshot,
  EngineTelemetryFeature,
  EngineUsageWindow,
} from './agent/runtime/types';
export {
  ENGINE_RUNTIME_CONTRACT_VERSION,
  assertEngineRuntimeDescriptor,
  defineEngineRuntimeDescriptor,
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
export {
  DEFAULT_PROFILE_CONVERSATION_DRAIN_MS,
  ProfileConversationRuntimeOwner,
} from './conversation/profile-runtime-owner';
export type {
  ConversationRuntimeDeps,
  RecordConversationEventInput,
  StartConversationInput,
  StartIntentInput,
} from './conversation/runtime';
export type { ProfileConversationRuntimeOwnerOptions } from './conversation/profile-runtime-owner';
export { createProfileConversationHost } from './conversation/profile-host';
export type {
  CreateProfileConversationHostOptions,
  ProfileConversationInput,
  ProfileConversationHost,
  ProfileConversationNativeReadOptions,
  ProfileConversationResetResult,
  ProfileTextConversationInput,
  ProfileTextConversationResult,
} from './conversation/profile-host';
export { FileAttachmentStore } from './media/file-store';
export type { FileAttachmentInput } from './media/file-store';
export type { ConversationSource } from './conversation/types';
export { ChannelPluginRegistry } from './channel/plugin/registry';
export {
  ExternalChannelPluginLoader,
  InstalledChannelPluginPackageSource,
} from './channel/plugin/loader';
export type {
  ExternalChannelPluginLoaderOptions,
  ExternalChannelPluginPackageMetadata,
  ExternalChannelPluginPackageSource,
  ExternalChannelPluginRequest,
  LoadedExternalChannelPlugin,
  ResolvedExternalChannelPluginPackage,
  TrustedExternalChannelPlugin,
} from './channel/plugin/loader';
export {
  CHANNEL_MANAGER_SNAPSHOT_VERSION,
  ChannelManager,
  DEFAULT_CHANNEL_MANAGER_DRAIN_MS,
} from './channel/manager';
export {
  BUILT_IN_LARK_CONFIG_VERSION,
  BUILT_IN_LARK_PLUGIN_ID,
  createSchemaV3ChannelsFromSchemaV2Profile,
  projectProfileChannelInstances,
  projectSchemaV2ChannelInstances,
  requirePrimaryLarkChannelInstance,
  SCHEMA_V2_LARK_INSTANCE_ID,
} from './channel/instance-resolver';
export {
  applyChannelSchemaV3Migration,
  CHANNEL_SCHEMA_MIGRATION_PLAN_VERSION,
  migrateProfileConfigToSchemaV3,
  migrateRootConfigToSchemaV3,
  planChannelSchemaV3Migration,
  rollbackChannelSchemaV3Migration,
} from './config/channel-schema-migration';
export {
  CURRENT_DEFAULT_LARK_CHANNEL_ROLLOUT_MODE,
  LARK_CHANNEL_ROLLOUT_ENV,
  resolveLarkChannelOwnership,
} from './channel/lark-ownership';
export { runChannelPluginContract } from './channel/plugin/contract-test-kit';
export { ChannelPluginError } from './channel/plugin/errors';
export { CHANNEL_PLUGIN_ABI_VERSION } from './channel/plugin/types';
export {
  assertCanonicalChannelPluginId,
  assertChannelInstanceRef,
  assertChannelPluginPackageName,
  assertChannelPluginPackageVersion,
  assertCapabilityAllowsInbound,
  assertCapabilityAllowsOutbound,
  assertChannelDeliveryReceipt,
  assertChannelDrainOptions,
  assertChannelDrainResult,
  assertChannelHealthSnapshot,
  assertChannelInboundEnvelope,
  assertChannelIngressAcceptance,
  assertChannelOutboundIntent,
  assertChannelPlugin,
  assertChannelPluginManifest,
  assertChannelRuntime,
  assertChannelRuntimeSnapshot,
  assertResolvedChannelInstance,
  channelRuntimeKey,
} from './channel/plugin/validation';
export type {
  ChannelAssetContent,
  ChannelCapabilities,
  ChannelConfig,
  ChannelContent,
  ChannelConversationKind,
  ChannelDeliveryReceipt,
  ChannelDrainOptions,
  ChannelDrainResult,
  ChannelHealthSnapshot,
  ChannelInboundEnvelope,
  ChannelIngressAcceptance,
  ChannelIngressMode,
  ChannelIngressPort,
  ChannelInstanceRef,
  ChannelMessageKind,
  ChannelOutboundIntent,
  ChannelPlugin,
  ChannelPluginContext,
  ChannelPluginManifest,
  ChannelPluginPackage,
  ResolvedChannelInstance,
  ChannelRuntime,
  ChannelRuntimeSnapshot,
  ChannelRuntimeState,
  ChannelStreamingMode,
} from './channel/plugin/types';
export type {
  ChannelPluginErrorKind,
  ChannelPluginErrorOptions,
} from './channel/plugin/errors';
export type {
  ChannelPluginContractOptions,
  ChannelPluginContractResult,
} from './channel/plugin/contract-test-kit';
export type {
  ChannelManagerDrainFailure,
  ChannelManagerDrainResult,
  ChannelManagerOptions,
  ChannelManagerSnapshot,
  ChannelManagerStartPlan,
  ChannelManagerState,
  ManagedChannelInstanceSnapshot,
  ManagedChannelInstanceState,
} from './channel/manager';
export type {
  LarkChannelConfig,
  LarkCredentialMode,
  ProfileChannelProjectionInput,
  SchemaV2ChannelInstances,
  SchemaV2ChannelProjectionInput,
  SchemaV3ChannelInstances,
  SchemaV3ChannelProjectionInput,
} from './channel/instance-resolver';
export type {
  ApplyChannelSchemaMigrationResult,
  ChannelSchemaMigrationOptions,
  ChannelSchemaMigrationPlan,
  ChannelSchemaMigrationProfilePlan,
  RollbackChannelSchemaMigrationResult,
} from './config/channel-schema-migration';
export type {
  LarkChannelOwnershipPolicy,
  LarkChannelRolloutMode,
} from './channel/lark-ownership';
export {
  ChannelReliabilityCoordinator,
  DEFAULT_CHANNEL_RELIABILITY_LEASE_MS,
} from './channel/reliability/coordinator';
export {
  assertChannelReliabilityKey,
  channelReceiptId,
  channelReliabilityKey,
  reliabilityKeyFromEnvelope,
} from './channel/reliability/key';
export { InMemoryChannelReliabilityStores } from './channel/reliability/memory-store';
export {
  FileChannelReliabilityStores,
  FILE_CHANNEL_RELIABILITY_SCHEMA_VERSION,
} from './channel/reliability/file-store';
export {
  assertChannelRetryPolicy,
  channelRetryDelay,
  DEFAULT_CHANNEL_RETRY_POLICY,
} from './channel/reliability/retry';
export type {
  ChannelAnswerCheckpoint,
  ChannelAnswerProcessor,
  ChannelAnswerStore,
  ChannelCompletionReceipt,
  ChannelDeliveryLedgerEntry,
  ChannelDeliveryStore,
  ChannelInboxRecord,
  ChannelInboxStore,
  ChannelIntentDeliverer,
  ChannelReliabilityKey,
  ChannelReliabilityRunResult,
  ChannelReliabilityStores,
  ChannelRetryPolicy,
  ChannelRetryRecord,
  ChannelRetryState,
  ChannelRetryStore,
} from './channel/reliability/types';
export type { ChannelReliabilityCoordinatorOptions } from './channel/reliability/coordinator';
export { WechatKfCallbackHandler } from './channel/wechat-kf/callback';
export type {
  WechatKfCallbackHandlerOptions,
  WechatKfCallbackRequest,
  WechatKfCallbackResponse,
} from './channel/wechat-kf/callback';
export {
  WechatKfApiClient,
  WechatKfApiError,
  WechatKfMediaError,
} from './channel/wechat-kf/client';
export type {
  WechatKfAccessTokenProvider,
  WechatKfApiClientOptions,
  WechatKfFetch,
} from './channel/wechat-kf/client';
export {
  DEFAULT_WECHAT_KF_USER_COPY,
  parseWechatKfCommand,
  renderWechatKfHelp,
  renderWechatKfWelcome,
  WECHAT_KF_COMMANDS,
  WECHAT_KF_WELCOME_TEXT,
} from './channel/wechat-kf/commands';
export type {
  WechatKfCommandDefinition,
  WechatKfCommandKind,
  WechatKfCommandMatch,
  WechatKfUserCopy,
} from './channel/wechat-kf/commands';
export { WechatKfCrypto } from './channel/wechat-kf/crypto';
export type { WechatKfCryptoOptions } from './channel/wechat-kf/crypto';
export { WechatKfDurableMessageSink } from './channel/wechat-kf/durable-sink';
export type {
  WechatKfDurableMessageSinkOptions,
  WechatKfProcessingErrorContext,
} from './channel/wechat-kf/durable-sink';
export {
  createBuiltInWechatKfChannelPlugin,
  createWechatKfChannelInstance,
  WECHAT_KF_CHANNEL_CONFIG_VERSION,
} from './channel/wechat-kf/channel-plugin';
export type {
  BuiltInWechatKfChannelPluginAdapter,
  BuiltInWechatKfChannelPluginOptions,
  WechatKfBridgeSnapshot,
  WechatKfChannelBridge,
  WechatKfChannelConfig,
} from './channel/wechat-kf/channel-plugin';
export {
  CURRENT_DEFAULT_WECHAT_KF_CHANNEL_ROLLOUT_MODE,
  resolveWechatKfChannelOwnership,
  WECHAT_KF_CHANNEL_ROLLOUT_ENV,
} from './channel/wechat-kf/ownership';
export type {
  WechatKfChannelOwnershipPolicy,
  WechatKfChannelRolloutMode,
} from './channel/wechat-kf/ownership';
export {
  WECHAT_KF_DEFAULT_INSTANCE_ID,
  WECHAT_KF_PLUGIN_ID,
  WechatKfReliableMessageSink,
  wechatKfMessageEnvelope,
} from './channel/wechat-kf/reliable-message-sink';
export type {
  WechatKfReliabilityContext,
  WechatKfReliableMessageSinkOptions,
  WechatKfReliableMessageSinkSnapshot,
} from './channel/wechat-kf/reliable-message-sink';
export { FileWechatKfDeliveryStore } from './channel/wechat-kf/delivery-store';
export type {
  WechatKfDeliveryChunk,
  WechatKfDeliveryChunkInput,
  WechatKfImageDeliveryChunk,
  WechatKfPreparedDelivery,
  WechatKfTextDeliveryChunk,
} from './channel/wechat-kf/delivery-store';
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
export { FileWechatKfMessageInbox } from './channel/wechat-kf/message-inbox';
export { FileWechatKfOnboardingStore } from './channel/wechat-kf/onboarding-store';
export {
  extractWechatKfMarkdownImages,
  renderWechatKfPlainText,
} from './channel/wechat-kf/plain-text-renderer';
export type {
  WechatKfMarkdownImage,
  WechatKfPlainTextRenderOptions,
} from './channel/wechat-kf/plain-text-renderer';
export {
  assertWechatKfPresentation,
  createDefaultWechatKfPresentation,
} from './channel/wechat-kf/presentation';
export type {
  WechatKfPresentation,
  WechatKfPresentationProvider,
  WechatKfPresentationRequest,
} from './channel/wechat-kf/presentation';
export { textOnlyWechatKfAnswer } from './channel/wechat-kf/outbound';
export type {
  WechatKfAnswerComposer,
  WechatKfAnswerComposerInput,
  WechatKfAnswerPart,
  WechatKfImageMaterialization,
  WechatKfImageMaterializer,
  WechatKfImageMaterializerInput,
} from './channel/wechat-kf/outbound';
export { WechatKfNotificationProcessor } from './channel/wechat-kf/processor';
export type {
  WechatKfMessageSink,
  WechatKfNotificationProcessorOptions,
} from './channel/wechat-kf/processor';
export { FileWechatKfReceiptStore } from './channel/wechat-kf/receipt-store';
export { wechatKfActorId, wechatKfScopeId } from './channel/wechat-kf/session';
export {
  messageReceiptKey,
  splitWechatKfText,
  stableOutboundMessageId,
  WechatKfTextHandler,
} from './channel/wechat-kf/text-handler';
export type {
  WechatKfCommandAuditEvent,
  WechatKfProcessingFeedback,
  WechatKfProcessingFeedbackContext,
  WechatKfProcessingFeedbackHandle,
  WechatKfTextHandlerOptions,
} from './channel/wechat-kf/text-handler';
export type {
  WechatKfMessage,
  WechatKfNotification,
  WechatKfNotificationSink,
  WechatKfImageContentType,
  WechatKfDownloadImageInput,
  WechatKfDownloadImageResult,
  WechatKfSendImageInput,
  WechatKfSendImageResult,
  WechatKfSendTextInput,
  WechatKfSendTextResult,
  WechatKfSyncMessagesInput,
  WechatKfSyncMessagesResult,
  WechatKfUploadImageInput,
  WechatKfUploadImageResult,
} from './channel/wechat-kf/types';
export { startProfileWechatKfChannelRuntime } from './runtime/wechat-kf-channel-runtime';
export type {
  ProfileWechatKfChannelRuntime,
  StartProfileWechatKfChannelRuntimeOptions,
} from './runtime/wechat-kf-channel-runtime';

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
export { nativeReadFactoryFromEnvironment } from './runtime/native-read-config';
export type { NativeReadEnvironmentOptions } from './runtime/native-read-config';
export type {
  NativeReadRuntimeFactory,
  NativeReadRuntimeFactoryContext,
} from './runtime/native-read-runtime';
export type { NativeReadScope } from './platform/native-read-http-server';
export type { RunAuditEvent, RunAuditSink } from './runtime/run-executor';
export type { GovernanceAuditAction, GovernanceAuditEvent, GovernanceAuditSink } from './runtime/governance-audit';
export type { MessageAuditEvent, MessageAuditSink } from './runtime/message-audit';
export type {
  MessageActorKind,
  MessageConversationKind,
  MessageResourceEvent,
  MessageResourceSink,
  MessageSessionBinding,
} from './runtime/message-resource';
