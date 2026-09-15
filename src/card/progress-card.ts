/** Terminal cleanup never reserializes an old private task's card body. */
export function interruptedProgressCard(): object {
  return { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '本次任务已中止。' }] } };
}
