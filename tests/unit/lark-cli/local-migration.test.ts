import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { copyLegacyLarkCliState } from '../../../src/lark-cli/local-migration';
import { principalId, type SpaceKey } from '../../../src/space/identity';
import { prepareSpacePaths, resolveSpacePaths } from '../../../src/space/paths';
it('copies only a durable owner grant and preserves encrypted bytes without importing pending slots', async () => {
  const root=await mkdtemp(join(tmpdir(),'aria-local-cli-migration-'));
  try {
    const principal={profileId:'p',authorityId:'a'.repeat(64),kind:'user' as const,subjectId:'owner'};
    const key:SpaceKey={kind:'user',profileId:'p',principal};
    const paths=resolveSpacePaths(root,key);await prepareSpacePaths(paths);
    const ref='a'.repeat(36),owner=principalId(principal);
    const source=join(root,'space-control','tool-credentials',createHash('sha256').update(ref).digest('hex'));
    const data=join(source,'home','.local','share','lark-cli');
    await mkdir(data,{recursive:true});await mkdir(join(source,'cli','lark-channel'),{recursive:true});
    const write=async(path:string,value:unknown)=>writeFile(path,JSON.stringify(value),{mode:0o600});
    await write(join(root,'space-control','tool-identity.v1.json'),{schema:'aria.space.tool-identity.v2',profileId:'p',pending:[{credentialRef:'never-copy'}],
      grants:[{spaceId:paths.spaceId,principalId:owner,providerId:'lark',credentialRef:ref}]});
    await write(join(source,'binding.json'),{schema:'aria.space.lark-cli.v1',spaceId:paths.spaceId,owner,authorityId:principal.authorityId,identity:'user',accountId:'cli_fixture'});
    await write(join(source,'cli','lark-channel','config.json'),{apps:[{appId:'cli_fixture'}]});
    await write(join(data,'master.key'),'fixture-key');await write(join(data,'cli_fixture_owner.enc'),'opaque-fixture-encrypted-bytes');
    const input={stateDirectory:root,key,cliDirectory:join(paths.config,'lark-cli'),dataDirectory:join(paths.data,'lark-cli')};
    const result=await copyLegacyLarkCliState(input);
    expect(result).toEqual({migrated:true,appId:'cli_fixture',files:3});
    expect(await readFile(join(input.dataDirectory,'cli_fixture_owner.enc'))).toEqual(await readFile(join(data,'cli_fixture_owner.enc')));
    await expect(copyLegacyLarkCliState(input)).rejects.toThrow('already exists');
    const otherKey:SpaceKey={...key,principal:{...principal,subjectId:'another'}};
    const other=resolveSpacePaths(root,otherKey);await prepareSpacePaths(other);
    expect(await copyLegacyLarkCliState({...input,key:otherKey,cliDirectory:join(other.config,'lark-cli'),dataDirectory:join(other.data,'lark-cli')})).toEqual({migrated:false,files:0});
    await expect(copyLegacyLarkCliState({...input,dataDirectory:join(other.data,'lark-cli')})).rejects.toThrow('another Space');
  }finally{await rm(root,{recursive:true,force:true});}
});
