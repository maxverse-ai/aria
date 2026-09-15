/** Source/tool presentation is composed before native engine injection. */
export interface SystemPromptParts {
  source: string;
  tools?: string;
  identity?: string;
}

/** Stable source and identity precede potentially run-specific tool instructions. */
export function composeSystemPrompt(parts: SystemPromptParts): string {
  return [parts.source, parts.identity, parts.tools]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join('\n');
}

/** Transport adapter for engines that accept only a single prompt string. */
export function prefixSystemPrompt(prompt: string, systemPrompt: string): string {
  return `${systemPrompt}\n\n## user_message\n\n${prompt}`;
}
