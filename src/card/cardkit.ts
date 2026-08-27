export interface CardKitButtonSpec {
  text: string;
  value: Record<string, unknown>;
  style?: 'primary' | 'danger' | 'default';
  disabled?: boolean;
}

export function cardKitButton(spec: CardKitButtonSpec): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: spec.text },
    type: spec.style ?? 'default',
    behaviors: [{ type: 'callback', value: spec.value }],
    ...(spec.disabled ? { disabled: true } : {}),
  };
}

export function cardKitMarkdown(content: string): object {
  return { tag: 'markdown', content };
}

export function cardKitButtonRow(buttons: CardKitButtonSpec[]): object {
  return {
    tag: 'column_set',
    flex_mode: 'none',
    horizontal_spacing: '8px',
    columns: buttons.map((spec) => ({
      tag: 'column',
      width: 'auto',
      elements: [cardKitButton(spec)],
    })),
  };
}

export const CARD_KIT_HR: object = { tag: 'hr' };

export function cardKitShell(title: string, elements: object[]): object {
  return {
    schema: '2.0',
    config: { summary: { content: title } },
    body: {
      elements: [cardKitMarkdown(`**${title}**`), ...elements],
    },
  };
}

export function cardKitActionState(
  title: string,
  phase: 'loading' | 'failure',
  message: string,
): object {
  const marker = phase === 'loading' ? '⏳' : '❌';
  return cardKitShell(title, [cardKitMarkdown(`${marker} ${message}`)]);
}
