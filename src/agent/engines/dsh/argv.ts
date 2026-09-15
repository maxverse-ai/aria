export function buildDshArgs(prompt: string, progressPatch: string): string[] {
  // Keep native model selection and headless lifecycle; the public patch adds
  // a separate fd 3 progress channel before the task starts.
  return ['--profile', 'headless', '--patch', progressPatch, prompt];
}
