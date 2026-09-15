import { createLarkChannel } from '@larksuite/channel';
import { expect, it, vi } from 'vitest';

it('the installed SDK turns the host handoff into an actual platform mention', async () => {
  const channel = createLarkChannel({ appId: 'cli_test', appSecret: 'test-only' });
  const create = vi.spyOn(channel.rawClient.im.v1.message, 'create').mockResolvedValue({
    code: 0, data: { message_id: 'om_handoff' },
  } as never);
  await channel.send('oc_chat', { text: '0' }, { mentions: [{ key: '@_aria_next', openId: 'ou_alice' }] });
  const request = create.mock.calls[0]?.[0];
  const body = JSON.parse(request?.data.content ?? '{}');
  expect(body.text).toContain('<at user_id="ou_alice">');
  expect(body.text).toContain('0');
  create.mockRestore();
});
