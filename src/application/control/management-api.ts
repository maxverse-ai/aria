import type { ConfigChangeService } from './config-change-service';
import type {
  ConfigChangeCommitResult,
  ControlActorContext,
  ControlChangeApplyResult,
  ControlChangePlanSnapshot,
  ControlPlanParameters,
} from './change-types';
import {
  DeferredRuntimeReconciler,
  type ManagementRuntimeEffect,
  type RuntimeReconcileOutcome,
  type RuntimeReconciler,
} from './runtime-effect';

export const MANAGEMENT_API_VERSION = 1 as const;

interface ManagementRequestContext {
  apiVersion: typeof MANAGEMENT_API_VERSION;
  requestId: string;
  actor: ControlActorContext;
}

export interface ManagementPlanRequest extends ManagementRequestContext {
  schema: 'aria.management.plan.request.v1';
  command: string;
  profile?: string;
  input?: ControlPlanParameters;
}

export interface ManagementPlanReadRequest extends ManagementRequestContext {
  schema: 'aria.management.plan-read.request.v1';
  planId: string;
}

export interface ManagementConfirmRequest extends ManagementRequestContext {
  schema: 'aria.management.confirm.request.v1';
  planId: string;
}

export interface ManagementCommitRequest extends ManagementRequestContext {
  schema: 'aria.management.commit.request.v1';
  planId: string;
}

export interface ManagementExecuteRequest extends ManagementRequestContext {
  schema: 'aria.management.execute.request.v1';
  command: string;
  profile?: string;
  input?: ControlPlanParameters;
}

export interface ManagementPlanResult {
  schema: 'aria.management.plan.v1';
  apiVersion: typeof MANAGEMENT_API_VERSION;
  requestId: string;
  plan: ControlChangePlanSnapshot;
}

export interface ManagementCommitResult extends ConfigChangeCommitResult {
  schema: 'aria.management.commit.v1';
  apiVersion: typeof MANAGEMENT_API_VERSION;
  requestId: string;
  reconciliation: RuntimeReconcileOutcome;
}

export interface ManagementExecuteResult {
  schema: 'aria.management.execute.v1';
  apiVersion: typeof MANAGEMENT_API_VERSION;
  requestId: string;
  planId: string;
  applyResult: ControlChangeApplyResult;
  effect: ManagementRuntimeEffect;
  reconciliation: RuntimeReconcileOutcome;
}

export type ManagementApiErrorCode = 'invalid-request' | 'unsupported-version';

export class ManagementApiError extends Error {
  constructor(
    public readonly code: ManagementApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ManagementApiError';
  }
}

/**
 * Versioned application facade shared by CLI, agent, card, and web adapters.
 * It owns protocol orchestration; mutation validation and persistence remain in
 * ConfigChangeService.
 */
export class ManagementApi {
  private readonly reconciler: RuntimeReconciler;

  constructor(
    private readonly changes: ConfigChangeService,
    reconciler?: RuntimeReconciler,
  ) {
    this.reconciler = reconciler ?? new DeferredRuntimeReconciler();
  }

  async plan(request: ManagementPlanRequest): Promise<ManagementPlanResult> {
    validateRequest(request, 'aria.management.plan.request.v1');
    if (!request.command.trim()) {
      throw new ManagementApiError('invalid-request', 'command is required');
    }
    const plan = await this.changes.createPlan({
      profile: request.profile,
      operationId: request.command,
      parameters: request.input,
      actor: request.actor,
    });
    return planResult(request.requestId, plan);
  }

  async getPlan(request: ManagementPlanReadRequest): Promise<ManagementPlanResult> {
    validateRequest(request, 'aria.management.plan-read.request.v1');
    validatePlanId(request.planId);
    return planResult(request.requestId, await this.changes.getPlan(request.planId));
  }

  async confirm(request: ManagementConfirmRequest): Promise<ManagementPlanResult> {
    validateRequest(request, 'aria.management.confirm.request.v1');
    validatePlanId(request.planId);
    return planResult(
      request.requestId,
      await this.changes.confirmPlan(request.planId, request.actor),
    );
  }

  async commit(request: ManagementCommitRequest): Promise<ManagementCommitResult> {
    validateRequest(request, 'aria.management.commit.request.v1');
    validatePlanId(request.planId);
    const result = await this.changes.commitPlan(request.planId, request.actor);
    const reconciliation = await this.reconcile(result);
    return {
      schema: 'aria.management.commit.v1',
      apiVersion: MANAGEMENT_API_VERSION,
      requestId: request.requestId,
      ...result,
      reconciliation,
    };
  }

  async execute(request: ManagementExecuteRequest): Promise<ManagementExecuteResult> {
    validateRequest(request, 'aria.management.execute.request.v1');
    if (!request.command.trim()) {
      throw new ManagementApiError('invalid-request', 'command is required');
    }
    const plan = await this.changes.createPlan({
      profile: request.profile,
      operationId: request.command,
      parameters: request.input,
      actor: request.actor,
    });
    await this.changes.confirmPlan(plan.id, request.actor);
    const committed = await this.changes.commitPlan(plan.id, request.actor);
    const reconciliation = await this.reconcile(committed);
    return {
      schema: 'aria.management.execute.v1',
      apiVersion: MANAGEMENT_API_VERSION,
      requestId: request.requestId,
      planId: plan.id,
      ...committed,
      reconciliation,
    };
  }

  private async reconcile(result: ConfigChangeCommitResult): Promise<RuntimeReconcileOutcome> {
    try {
      const outcome = await this.reconciler.reconcile({
        profile: result.applyResult.profile,
        effect: result.effect,
        revision: result.applyResult.resultRevision,
      });
      if (!matchesEffect(result.effect, outcome)) {
        return failedOutcome(result.effect, 'runtime-reconcile-contract-violation');
      }
      return outcome;
    } catch {
      return failedOutcome(result.effect, 'runtime-reconciler-error');
    }
  }
}

function planResult(requestId: string, plan: ControlChangePlanSnapshot): ManagementPlanResult {
  return {
    schema: 'aria.management.plan.v1',
    apiVersion: MANAGEMENT_API_VERSION,
    requestId,
    plan,
  };
}

function validateRequest(
  request: ManagementRequestContext & { schema: string },
  schema: string,
): void {
  if (request.apiVersion !== MANAGEMENT_API_VERSION) {
    throw new ManagementApiError(
      'unsupported-version',
      `unsupported management API version: ${String(request.apiVersion)}`,
    );
  }
  if (request.schema !== schema || !isIdentifier(request.requestId)) {
    throw new ManagementApiError('invalid-request', 'valid schema and requestId are required');
  }
}

function validatePlanId(planId: string): void {
  if (!/^[a-f0-9]{32}$/.test(planId)) {
    throw new ManagementApiError('invalid-request', 'valid planId is required');
  }
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function matchesEffect(effect: ManagementRuntimeEffect, outcome: RuntimeReconcileOutcome): boolean {
  return effect === outcome.effect;
}

function failedOutcome(
  effect: ManagementRuntimeEffect,
  code: string,
): RuntimeReconcileOutcome {
  if (effect === 'none') return { status: 'not-required', effect: 'none' };
  return { status: 'failed', effect, code };
}
