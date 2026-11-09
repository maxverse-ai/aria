import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChannelReliabilityCoordinator } from '../../../../src/channel/reliability/coordinator';
import { InMemoryChannelReliabilityStores } from '../../../../src/channel/reliability/memory-store';
import { reliabilityKeyFromEnvelope } from '../../../../src/channel/reliability/key';
import { sendManagedCard } from '../../../../src/card/managed';
import { putSteerMail, listSteerMails, unreadSteerMails, STEER_MAIL_TTL_MS } from '../../../../src/conversation/steer-mailbox';
const envelope:any={abiVersion:1,profileId:'audit',pluginId:'fixture-channel',instanceId:'primary',sourceMessageId:'input',scopeId:'scope',actorId:'actor',conversation:'p2p',occurredAt:0,content:{kind:'text',text:'hello'}};
async function leaseProbe(){
 const stores=new InMemoryChannelReliabilityStores();let now=0;let calls=0;let release!:()=>void;let entered!:()=>void;
 const gate=new Promise<void>(r=>release=r);const started=new Promise<void>(r=>entered=r);
 const processor={process:async()=>{calls++;if(calls===1){entered();await gate;}return []}};
 const options={stores,processor,deliverer:{deliver:async()=>{throw Error('unexpected delivery')}},now:()=>now,leaseMs:30};
 const a=new ChannelReliabilityCoordinator(options),b=new ChannelReliabilityCoordinator(options);
 await a.accept(envelope);const key=reliabilityKeyFromEnvelope(envelope);const first=a.run(key);await started;now=31;const second=await b.run(key);release();const result=await first;
 console.log(JSON.stringify({probe:'expired-live-worker',processorCalls:calls,first:result.status,second:second.status}));
}
async function fallbackProbe(){let sends=0;const remote:any[]=[];const channel:any={createCard:async()=>({cardId:'audit-card'}),send:async(_recipient:any,body:any)=>{sends++;remote.push(body);if(sends===1)throw Error('timeout after provider accepted');return {messageId:'fallback'}}};const result=await sendManagedCard(channel,'oc_fixture',{schema:'2.0',body:{elements:[]}});console.log(JSON.stringify({probe:'ambiguous-managed-send',remoteAcceptedMessages:remote.length,bodyKinds:remote.map(x=>Object.keys(x)[0]),returnedMessageId:result.messageId}));}
function ttlProbe(){const root=mkdtempSync(join(tmpdir(),'aria-delivery-audit-'));try {putSteerMail(root,'scope',{requestId:'expired',body:'synthetic body'},0);const now=STEER_MAIL_TTL_MS+1;const visible=listSteerMails(root,'scope',now);const unread=unreadSteerMails(root,'scope',now);console.log(JSON.stringify({probe:'unread-mail-expiry',visible:visible.length,unread:unread.length,files:readdirSync(join(root,'scope')).filter(n=>n.endsWith('.json')).length}));}finally{rmSync(root,{recursive:true,force:true});}}
await leaseProbe();await fallbackProbe();ttlProbe();
import { FileChannelReliabilityStores } from '../../../../src/channel/reliability/file-store';
async function fileLeaseProbe(){const root=mkdtempSync(join(tmpdir(),'aria-file-lease-audit-'));try{const stores=new FileChannelReliabilityStores(join(root,'state.json'));let now=0,calls=0;let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const options={stores,processor:{process:async()=>{calls++;if(calls===1){entered();await gate;}return []}},deliverer:{deliver:async()=>{throw Error('unexpected')}},now:()=>now,leaseMs:30};const a=new ChannelReliabilityCoordinator(options),b=new ChannelReliabilityCoordinator(options);await a.accept(envelope);const key=reliabilityKeyFromEnvelope(envelope),first=a.run(key);await started;now=31;const second=await b.run(key);release();await first;console.log(JSON.stringify({probe:'file-expired-live-worker',processorCalls:calls,second:second.status}));}finally{rmSync(root,{recursive:true,force:true})}}
await fileLeaseProbe();
import { PendingQueue } from '../../../../src/bot/pending-queue';
import { pullSteerMails, markSteerMail } from '../../../../src/conversation/steer-mailbox';
function rejectedNoticeRace(){const root=mkdtempSync(join(tmpdir(),'aria-notice-race-'));const pending=new PendingQueue(60000,()=>{});try{const input:any={message:{messageId:'race-input'}};pending.push('scope',input);const claim=pending.claim('scope',[input],'im:race-input')!;putSteerMail(root,'scope',{requestId:'im:race-input',body:'synthetic instruction'});const consumed=pullSteerMails(root,'scope');markSteerMail(root,'scope','im:race-input','dropped');pending.release(claim);console.log(JSON.stringify({probe:'pull-before-notice-rejection',pulled:consumed.length,nextTurnQueued:pending.snapshot('scope').length,mailState:listSteerMails(root,'scope')[0]?.state}));}finally{pending.cancelAll();rmSync(root,{recursive:true,force:true})}}
rejectedNoticeRace();
