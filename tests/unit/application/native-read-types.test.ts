import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  NATIVE_AUDIT_ACTIONS,
  NATIVE_READ_API_VERSION,
  NATIVE_READ_RESOURCE_TYPES,
  NATIVE_READ_ROUTES,
  type NativeAuditEventResource,
  type NativeMessageResource,
  type NativeReadChangesResponse,
  type NativeReadCapabilitiesResponse,
  type NativeReadErrorResponse,
  type NativeReadHealthResponse,
  type NativeReadListResponse,
  type NativeReadMetaResponse,
} from '../../../src/application/control/native-read-types.js';

describe('native read API v1 contracts', () => {
  it('uses an independent version and complete resource taxonomy', () => {
    expect(NATIVE_READ_API_VERSION).toBe(1);
    expect(NATIVE_READ_RESOURCE_TYPES).toEqual([
      'profile',
      'session',
      'message',
      'run',
      'identity',
      'chat',
      'chat-member',
      'audit-event',
    ]);
  });

  it('declares source-side governance actions without inferred transcript audit', () => {
    expect(NATIVE_AUDIT_ACTIONS).toContain('tool.started');
    expect(NATIVE_AUDIT_ACTIONS).toContain('policy.decided');
    expect(NATIVE_AUDIT_ACTIONS).toContain('credential.accessed');
    expect(NATIVE_AUDIT_ACTIONS).not.toContain('conversation.inferred');
  });

  it('keeps content availability explicit when text is not authorized', () => {
    const message = {
      resourceType: 'message',
      id: 'message_1',
      profileId: 'profile_1',
      revision: 1,
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
      conversationId: 'conversation_1',
      sessionId: 'session_1',
      associationStatus: 'resolved',
      sequence: 1,
      occurredAt: '2026-08-27T00:00:00.000Z',
      role: 'user',
      direction: 'inbound',
      content: { available: false, redacted: true, format: 'unavailable' },
      attachmentIds: [],
    } satisfies NativeMessageResource;

    expect(message.content).not.toHaveProperty('text');
    expectTypeOf(message).toMatchTypeOf<NativeMessageResource>();
  });

  it('makes list watermarks and change deduplication fields mandatory', () => {
    expectTypeOf<NativeReadListResponse>().toHaveProperty('snapshotCursor');
    expectTypeOf<NativeReadChangesResponse>().toHaveProperty('nextCursor');
    expectTypeOf<NativeReadChangesResponse['changes'][number]>().toHaveProperty('eventId');
    expectTypeOf<NativeReadChangesResponse['changes'][number]>().toHaveProperty('revision');
  });

  it('requires expired cursors to support a deterministic resnapshot response', () => {
    const response = {
      schema: 'aria.read.error.v1',
      apiVersion: 1,
      requestId: 'request_1',
      error: {
        code: 'CURSOR_EXPIRED',
        message: 'cursor is outside retention',
        retryable: true,
        resnapshotRequired: true,
      },
    } satisfies NativeReadErrorResponse;
    expect(response.error.resnapshotRequired).toBe(true);
  });

  it('keeps audit append-only and content-free by contract', () => {
    expectTypeOf<NativeAuditEventResource>().not.toHaveProperty('content');
    expectTypeOf<NativeAuditEventResource>().not.toHaveProperty('toolArguments');
    expectTypeOf<NativeAuditEventResource>().not.toHaveProperty('toolResult');
  });

  it('declares discovery, resource, change, and health routes', () => {
    expect(NATIVE_READ_ROUTES).toContain('/v1/capabilities');
    expect(NATIVE_READ_ROUTES).toContain('/v1/sessions/{sessionId}/messages');
    expect(NATIVE_READ_ROUTES).toContain('/v1/audit/events');
    expect(NATIVE_READ_ROUTES).toContain('/v1/changes');
    expect(NATIVE_READ_ROUTES).toContain('/readyz');
    expectTypeOf<NativeReadMetaResponse>().toHaveProperty('instanceId');
    expectTypeOf<NativeReadCapabilitiesResponse['capabilities'][number]>().toHaveProperty('requiredScopes');
    expectTypeOf<NativeReadHealthResponse>().toHaveProperty('checks');
  });
});
