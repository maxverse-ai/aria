import type { LarkChannel } from '@larksuite/channel';
import { SpaceOperationGate } from '../space/operation-gate';

/** Final release gate, below policy/card wrappers and above the actual SDK. */
export function spaceLarkChannel(raw: LarkChannel, gate: SpaceOperationGate): LarkChannel {
  const channel: LarkChannel = new Proxy(raw, {
    get(target, key) {
      if (key === 'rawClient') throw new Error('team raw SDK access requires an explicit bound adapter');
      if (key === 'createChat' || key === 'listChats') return () => Promise.reject(new Error('team chat management requires a management adapter'));
      if (key === 'reply') return (msg: Parameters<LarkChannel['reply']>[0], input: Parameters<LarkChannel['reply']>[1], opts?: Parameters<LarkChannel['reply']>[2]) =>
        channel.send(msg.chatId, input, { ...opts, replyTo: opts?.replyTo ?? msg.messageId, replyInThread: opts?.replyInThread ?? Boolean(msg.threadId) });
      if (key === 'send') return async (...args: Parameters<LarkChannel['send']>) => {
        if (['image', 'file', 'audio', 'video'].some((key) => key in args[1])) throw new Error('team attachment output requires a bound upload adapter');
        const operation = gate.active();
        if (args[2]?.replyTo) gate.resources.assert(operation.context, 'message', args[2].replyTo);
        if ('cardId' in args[1] && typeof args[1].cardId === 'string') gate.resources.assert(operation.context, 'card', args[1].cardId);
        const owner = gate.resources.captureProgressOwner(operation.context);
        const result = await gate.deliver(args[0], () => target.send(...args));
        await gate.resources.recordIssuedResource(owner, 'message', result.messageId);
        return result;
      };
      // SDK-owned streaming frames cannot be individually authorized. Team
      // progress instead uses explicit snapshots through the checked adapter.
      if (key === 'stream') return () => Promise.reject(new Error('space delivery requires buffered output'));
      if (key === 'createCard') return async (...args: Parameters<LarkChannel['createCard']>) => {
        const operation = gate.active();
        const owner = gate.resources.captureProgressOwner(operation.context);
        const result = await gate.deliver(operation.request.conversationId, () => target.createCard(...args));
        await gate.resources.recordIssuedResource(owner, 'card', result.cardId);
        return result;
      };
      if (key === 'updateCard' || key === 'updateCardById') return async (...args: unknown[]) => {
        const operation = gate.active();
        gate.resources.assert(operation.context, key === 'updateCard' ? 'message' : 'card', String(args[0]));
        return gate.deliver(operation.request.conversationId, () => Reflect.apply(target[key], target, args));
      };
      if (['fetchRawMessage', 'fetchMessage', 'editMessage', 'recallMessage', 'addReaction', 'removeReaction', 'removeReactionByEmoji',
        'downloadResource', 'downloadResourceWithMeta', 'downloadResourceToFile'].includes(String(key))) return async (...args: unknown[]) => {
          const operation = gate.active();
          gate.resources.assert(operation.context, 'message', String(args[0]));
          await gate.refresh(operation);
          const result = await Reflect.apply(Reflect.get(target, key), target, args);
          await gate.refresh(operation);
          return result;
        };
      if (key === 'comments') return new Proxy(target.comments, { get() {
        throw new Error('space comments require a verified resource audience adapter');
      } });
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return channel;
}
