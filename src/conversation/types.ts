/** Built-in sources plus namespaced sources supplied by channel plugins. */
export type ConversationSource =
  | 'im'
  | 'card'
  | 'comment'
  | 'meeting'
  | `channel:${string}`;
