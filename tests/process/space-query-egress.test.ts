import { expect, it } from 'vitest';
import { publicModelAddress } from '../../src/space/egress';

it('rejects DNS targets in private, reserved, documentation and IPv6 ranges', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::1', '224.0.0.1']) expect(publicModelAddress(address)).toBe(false);
  expect(publicModelAddress('8.8.8.8')).toBe(true);
});
