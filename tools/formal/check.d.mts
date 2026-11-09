interface Case { name: string; model: string; config?: string; configFile?: string; violation?: string }
interface Group { id: string; source: string[]; tests: string[]; cases: Case[] }
export const manifest: { toolchain: { sha256: string }; groups: Group[] };
export function selectGroups(ids: string[]): Group[];
export function verifyJar(bytes: Uint8Array): void;
export function expectedResult(result: {
  stdout?: string; stderr?: string; status: number | null; signal?: string | null; error?: Error;
}, violation?: string): boolean;
