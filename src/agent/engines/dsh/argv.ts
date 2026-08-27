export function buildDshArgs(prompt: string): string[] {
  // dsh launcher: `--profile headless` then the task positional. The prompt is
  // the last argv token (dsh has no stdin prompt transport).
  return ['--profile', 'headless', prompt];
}
