import {
  triggerCapabilities,
  triggerContractSchema,
  type TriggerCapabilitySnapshot,
  type TriggerContractSchemaSnapshot,
} from '../../application/execution-intent';

export interface TriggerContractCliOptions {
  json?: boolean;
}

export async function runTriggerCapabilities(
  opts: TriggerContractCliOptions = {},
): Promise<void> {
  const snapshot = triggerCapabilities();
  printSnapshot(snapshot, opts.json, formatTriggerCapabilities);
}

export async function runTriggerSchema(
  name: string,
  opts: TriggerContractCliOptions = {},
): Promise<void> {
  const snapshot = triggerContractSchema(name);
  printSnapshot(snapshot, opts.json, formatTriggerSchema);
}

function printSnapshot<T>(snapshot: T, json: boolean | undefined, format: (value: T) => string): void {
  console.log(json ? JSON.stringify(snapshot, null, 2) : format(snapshot));
}

export function formatTriggerCapabilities(snapshot: TriggerCapabilitySnapshot): string {
  return [
    `Aria trigger API v${snapshot.apiVersion}`,
    `implementation: ${snapshot.implementationStage}`,
    'runtime: disabled (schedule domain only; no scheduled execution is shipped)',
    ...snapshot.capabilities.map((item) => `- ${item.id}: ${item.cli} [${item.access}]`),
  ].join('\n');
}

export function formatTriggerSchema(snapshot: TriggerContractSchemaSnapshot): string {
  return [
    `Aria trigger contract · ${snapshot.name} v${snapshot.contractVersion}`,
    JSON.stringify(snapshot.jsonSchema, null, 2),
  ].join('\n');
}
