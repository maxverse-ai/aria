export type WechatKfAnswerPart =
  | { kind: 'text'; content: string }
  | { kind: 'image'; assetRef: string };

export interface WechatKfAnswerComposerInput {
  /** Complete agent answer before channel-specific plain-text rendering. */
  content: string;
}

/**
 * Deployment-owned answer composition seam.
 *
 * Aria owns wxkf transport and durable delivery. Deployments may resolve
 * product-specific, pre-authorized assets and return already-uploaded media
 * IDs without exposing those policies to the reusable channel adapter.
 */
export type WechatKfAnswerComposer = (
  input: Readonly<WechatKfAnswerComposerInput>,
) => Promise<ReadonlyArray<WechatKfAnswerPart>>;

export interface WechatKfImageMaterializerInput {
  /** Opaque deployment-owned reference previously approved by the answer composer. */
  assetRef: string;
}

export interface WechatKfImageMaterialization {
  mediaId: string;
  /** Epoch milliseconds. Omit only when the transport identifier does not expire. */
  expiresAt?: number;
}

export type WechatKfImageMaterializer = (
  input: Readonly<WechatKfImageMaterializerInput>,
) => Promise<Readonly<WechatKfImageMaterialization>>;

export function textOnlyWechatKfAnswer(content: string): readonly WechatKfAnswerPart[] {
  return [{ kind: 'text', content }];
}
