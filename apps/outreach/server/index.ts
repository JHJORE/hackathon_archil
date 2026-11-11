import dotenv from 'dotenv';
dotenv.config({quiet:true});
import express from 'express';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { Response } from 'express';
import type { RuntimeSnapshot } from '../shared/types.js';
import { ArchilStore, FileStore } from './store.js';
import { Events } from './events.js';
import { PriorityScheduler } from './scheduler.js';
import { CodexGateway, redact } from './codex.js';
import { ResearchService } from './research.js';
import { Orchestrator } from './orchestrator.js';
import { assertStrictSchema } from './schema.js';
import { researchSynthesisSchema, evaluatorSchema } from './research-schemas.js';
import { negotiationSchema } from './negotiation-schema.js';
import { parseRfq, requireResearchConnection } from './rfq-input.js';
import { AgentMailProvider } from './agentmail.js';
import { emailNegotiationSchema } from './email-negotiation.js';
import { emailRoutes } from './email-routes.js';
import { localRequestGuard } from './local-request.js';
import { ScoutService } from './scout.js';
import { scoutRoutes } from './scout-routes.js';
import type { EmailStatus } from '../shared/email.js';
import { storageConfiguration } from './runtime-config.js';
import { RfqUploadService } from './rfq-upload.js';
import { rfqUploadRoutes } from './rfq-upload-routes.js';
import { rfqUploadSchema } from './rfq-upload-schema.js';

for (const schema of [researchSynthesisSchema, evaluatorSchema, negotiationSchema, emailNegotiationSchema, rfqUploadSchema]) assertStrictSchema(schema);

const port=Number(process.env.PORT||4310);
const { diskId, storagePrefix, localStorage }=storageConfiguration();
const store=localStorage?new FileStore(resolve('work/local-test-store')):new ArchilStore(diskId,storagePrefix);
const events=new Events();
const clients=new Set<Response>();
let recovered=false,startupError:string|null=null;
const runtime:RuntimeSnapshot={slots:[],queue:[],execJobs:[],keenable:{searches:0,fetches:0,credits:0},config:{archil:!!process.env.ARCHIL_API_KEY,keenable:!!process.env.KEENABLE_API_KEY,model:'Local Codex',storage:localStorage?'Local test storage':'Archil'}};
function snapshot(){runtime.slots=scheduler.slots.map(s=>({...s}));runtime.queue=scheduler.queue;runtime.config.keenable=!!process.env.KEENABLE_API_KEY;runtime.config.archil=!!process.env.ARCHIL_API_KEY;return runtime;}
function pushSnapshot(){for(const client of clients)client.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);}
const scheduler=new PriorityScheduler(3,()=>pushSnapshot());
const model=new CodexGateway(scheduler,events);
const research=new ResearchService({store,model,events,diskId,storagePrefix,
  onExec:job=>{const at=runtime.execJobs.findIndex(j=>j.id===job.id);if(at>=0)runtime.execJobs[at]=job;else runtime.execJobs.push(job);runtime.execJobs=runtime.execJobs.slice(-12);pushSnapshot();},
  onUsage:(kind,credits)=>{runtime.keenable[kind]++;runtime.keenable.credits+=credits;pushSnapshot();},
});
const mail=new AgentMailProvider();
const orchestrator=new Orchestrator({store,model,research,events,mail});
const uploads=new RfqUploadService({store,model,events});
let emailRefresh:Promise<EmailStatus>|null=null;
function refreshEmail():Promise<EmailStatus>{
  if(emailRefresh)return emailRefresh;
  emailRefresh=orchestrator.emailStatus().then(status=>{runtime.email=status;pushSnapshot();return status;}).finally(()=>{emailRefresh=null;});
  return emailRefresh;
}
events.emitter.on('event',event=>{for(const client of clients)client.write(`id: ${event.id}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`);});
const app=express();
app.disable('x-powered-by');
app.use(localRequestGuard(port));
app.use(express.json({limit:'256kb'}));
app.use('/api',(req,_res,next)=>{
  const before = `${!!process.env.KEENABLE_API_KEY}:${!!process.env.ARCHIL_API_KEY}`;
  dotenv.config({quiet:true,override:true});
  if(before !== `${!!process.env.KEENABLE_API_KEY}:${!!process.env.ARCHIL_API_KEY}`) pushSnapshot();
  next();
});
const id=(value:unknown)=>{if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(value))throw Object.assign(new Error('Invalid identifier'),{status:400});return value;};
const ready=()=>{if(!recovered)throw Object.assign(new Error(startupError||'Recovering persisted cases; try again shortly'),{status:503});};
app.use('/api', scoutRoutes({ scout: new ScoutService(), orchestrator, ready }));
app.use('/api',emailRoutes({orchestrator,mail,ready,refresh:refreshEmail}));
app.use('/api',rfqUploadRoutes({uploads,orchestrator,events,ready}));
app.get('/api/health',(_req,res)=>res.json({ready:recovered,error:startupError}));
app.get('/api/runtime',(_req,res)=>res.json(snapshot()));
app.get('/api/events',(req,res)=>{
  res.set({'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.flushHeaders();clients.add(res);
  res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
  const last=req.get('Last-Event-ID');if(last){const at=events.recent.findIndex(e=>e.id===last);if(at>=0)for(const event of events.recent.slice(at+1))res.write(`id: ${event.id}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`);}
  const interval=setInterval(()=>res.write(': heartbeat\n\n'),15000);req.on('close',()=>{clearInterval(interval);clients.delete(res);});
});
app.get('/api/cases',(_req,res)=>res.json({cases:orchestrator.list()}));
app.post('/api/cases',async(req,res)=>{ready();res.status(201).json(await orchestrator.create(parseRfq(req.body?.rfq)));});
app.post('/api/cases/:id/replay',async(req,res)=>{ready();res.status(201).json(await orchestrator.replay(id(req.params.id)));});
app.get('/api/cases/:id',async(req,res)=>{ready();res.json(await orchestrator.detail(id(req.params.id)));});
const runs=new Set<string>();
app.post('/api/cases/:id/run',async(req,res)=>{
  ready();const caseId=id(req.params.id);const detail=await orchestrator.detail(caseId);
  if(runs.has(caseId))return res.status(202).json({status:'already running'});
  requireResearchConnection(detail.state,process.env.KEENABLE_API_KEY);
  runs.add(caseId);void orchestrator.start(caseId).catch(error=>events.emit('case.error',redact(error.message),{},caseId)).finally(()=>runs.delete(caseId));
  res.status(202).json({status:'started'});
});
app.post('/api/cases/:id/inbox/reply',async(req,res)=>{
  ready();const caseId=id(req.params.id),messageId=id(req.body?.messageId),supplierId=id(req.body?.supplierId);
  if(typeof req.body?.text!=='string'||!req.body.text.trim()||req.body.text.length>16000)return res.status(400).json({error:'Reply text must be between 1 and 16000 characters'});
  const result=await orchestrator.receive(caseId,{messageId,supplierId,text:req.body.text});res.status(202).json(result);
});
app.post('/api/cases/:id/hold',async(req,res)=>{
  ready();if(![0,5000].includes(req.body?.holdProcessingMs))return res.status(400).json({error:'holdProcessingMs must be 0 or 5000'});
  res.json(await orchestrator.setHold(id(req.params.id),req.body.holdProcessingMs));
});
app.post('/api/cases/:id/read',async(req,res)=>{
  ready();res.json(await orchestrator.markRead(id(req.params.id),id(req.body?.supplierId)));
});
app.post('/api/cases/:id/demo',async(req,res)=>{
  ready();const actions=['initial-quotes','duplicate','spec-mutation','final-reply'];if(!actions.includes(req.body?.action))return res.status(400).json({error:'Unknown demo action'});
  res.json(await orchestrator.demo(id(req.params.id),req.body.action));
});
if(existsSync(resolve('dist/index.html'))){app.use(express.static(resolve('dist')));app.get('/{*path}',(req,res)=>{if(req.path.startsWith('/api/'))return res.status(404).json({error:'Unknown API endpoint'});res.sendFile(resolve('dist/index.html'));});}
app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>{
  const message=redact(error?.message||'Unexpected server error');const status=error.status||(/not found/i.test(message)?404:/conflict/i.test(message)?409:500);
  res.status(status).json({error:message});
});
const server=app.listen(port,'127.0.0.1',()=>{
  console.log(`Source Control → http://127.0.0.1:${port}`);
  void orchestrator.recover().then(()=>uploads.recover()).then(async()=>{recovered=true;events.emit('recovery.complete','Archil reconciliation complete; inbox monitoring is active');await refreshEmail();pushSnapshot();})
    .catch(error=>{startupError=redact(error.message);events.emit('recovery.error',startupError);console.error(startupError);});
});
let polling=false;
const emailPoll=setInterval(()=>{
  if(!recovered||polling)return;
  polling=true;
  dotenv.config({quiet:true,override:true});
  void orchestrator.syncEmail().catch(error=>events.emit('email.sync_error',redact(error.message))).finally(async()=>{
    try{await refreshEmail();}catch(error){events.emit('email.status_error',redact((error as Error).message));}finally{polling=false;}
  });
},15000);
emailPoll.unref();
server.on('error',error=>{console.error(redact(error.message));model.shutdown();process.exitCode=1;});
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{clearInterval(emailPoll);model.shutdown();for(const client of clients)client.end();server.close(()=>process.exit(0));setTimeout(()=>process.exit(0),1500).unref();});
