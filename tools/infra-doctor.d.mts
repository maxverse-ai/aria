export type ToolchainCheckStatus = "pass" | "warn" | "fail";

export interface ToolchainReport {
  ok: boolean;
  checks: Array<{ id: string; status: ToolchainCheckStatus; detail: string }>;
}

export function parseNumericVersion(value: string): [number, number, number];
export function compareNumericVersions(left: [number, number, number], right: [number, number, number]): number;
export function evaluateToolchain(input: {
  nodeVersion: string;
  minimumNode: string;
  preferredNode: string;
  pnpmVersion: string;
  expectedPnpm: string;
  gitAvailable: boolean;
  tarAvailable: boolean;
  lockfileExists: boolean;
}): ToolchainReport;
