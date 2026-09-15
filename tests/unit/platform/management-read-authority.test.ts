import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { ManagementReadAuthority } from '../../../src/platform/management-read-authority';

it('binds management signatures to profile, method, complete route, time and single-use nonce', () => {
  const keys=generateKeyPairSync('ed25519'); let now=1788858000000;
  const publicKey=keys.publicKey.export({ format:'pem',type:'spki' }).toString();
  const authority=new ManagementReadAuthority(publicKey,'p',()=>now);
  const proof=(profile='p', issued=now) => {
    const nonce=randomBytes(16).toString('hex'); const time=String(issued);
    const payload=['aria-management-v1',profile,'GET','/v1/session-summaries?limit=200',time,nonce].join('\n');
    return ['aria-management-v1',time,nonce,sign(null,Buffer.from(payload),keys.privateKey).toString('base64url')].join(':');
  };
  const header=proof();
  expect(authority.authorize(header,'GET','/v1/messages')).toBe(false);
  expect(authority.authorize(header,'POST','/v1/session-summaries?limit=200')).toBe(false);
  expect(authority.authorize(proof('other'),'GET','/v1/session-summaries?limit=200')).toBe(false);
  expect(authority.authorize(proof('p',now-30_001),'GET','/v1/session-summaries?limit=200')).toBe(false);
  expect(authority.authorize(proof('p',now+5_001),'GET','/v1/session-summaries?limit=200')).toBe(false);
  expect(authority.authorize(publicKey,'GET','/v1/session-summaries?limit=200')).toBe(false);
  expect(authority.authorize(header,'GET','/v1/session-summaries?limit=200')).toBe(true);
  expect(authority.authorize(header,'GET','/v1/session-summaries?limit=200')).toBe(false);
  now+=31_000; expect(authority.authorize(header,'GET','/v1/session-summaries?limit=200')).toBe(false);
});
