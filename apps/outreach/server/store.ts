import * as archil from 'disk';
import type { Store } from '../shared/types.js';
import { isDeepStrictEqual } from 'node:util';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function safeKey(key: string): string {
  if (!key || key.startsWith('/') || key.split('/').some(p=>p==='..'||p==='.') || key.includes('\\') || key.includes('\0')) throw new Error('Invalid storage key');
  return key;
}
abstract class BaseStore implements Store {
  abstract getText(key:string):Promise<string|null>;
  abstract putText(key:string,text:string):Promise<void>;
  abstract list(prefix:string):Promise<string[]>;
  async get<T>(key:string):Promise<T|null> { const value=await this.getText(key); return value===null?null:JSON.parse(value) as T; }
  async put(key:string,value:unknown) { await this.putText(key,JSON.stringify(value,null,2)); }
  private locks = new Map<string,Promise<void>>();
  async immutable(key:string,value:unknown):Promise<void> {
    const previous=this.locks.get(key)||Promise.resolve();
    const run=previous.catch(()=>{}).then(async()=>{
      const existing=await this.get(key);
      if(existing!==null) { if(!isDeepStrictEqual(existing,value)) throw new Error(`Immutable record conflict: ${key}`); return; }
      await this.put(key,value);
    });
    this.locks.set(key,run);
    try { await run; } finally { if(this.locks.get(key)===run)this.locks.delete(key); }
  }
}
export class ArchilStore extends BaseStore {
  private diskPromise: Promise<archil.Disk> | null = null;
  private credential: string | undefined;
  private region: string | undefined;
  constructor(readonly diskId:string, readonly prefix='autonomous-sourcing/v1/') { super(); }
  private disk() {
    if(!process.env.ARCHIL_API_KEY) throw new Error('ARCHIL_API_KEY is missing from the local environment');
    const region=process.env.ARCHIL_REGION||'aws-us-east-1';
    if(!this.diskPromise||this.credential!==process.env.ARCHIL_API_KEY||this.region!==region) {
      this.credential=process.env.ARCHIL_API_KEY;this.region=region;
      archil.configure({apiKey:this.credential,region});
      this.diskPromise=archil.getDisk(this.diskId).catch(e=>{this.diskPromise=null;throw e;});
    }
    return this.diskPromise;
  }
  async getText(key:string) {
    try { return new TextDecoder().decode(await (await this.disk()).getObject(this.prefix+safeKey(key))); }
    catch(e:any) { if(e.status===404||e.statusCode===404||e.code==='NoSuchKey'||e.code==='NotFound')return null;throw e; }
  }
  async putText(key:string,text:string) { await (await this.disk()).putObject(this.prefix+safeKey(key),text,{contentType:'application/json; charset=utf-8'}); }
  async list(prefix:string) {
    const result=await (await this.disk()).listObjects(this.prefix+prefix,{recursive:true});
    return result.objects.map(o=>o.key.slice(this.prefix.length)).filter(k=>!k.endsWith('/'));
  }
}
/** Explicit test/offline adapter. Never selected automatically when Archil fails. */
export class FileStore extends BaseStore {
  constructor(readonly root:string) {super();}
  async getText(key:string) { try{return await readFile(resolve(this.root,safeKey(key)),'utf8');}catch(e:any){if(e.code==='ENOENT')return null;throw e;} }
  async putText(key:string,text:string) {
    const file=resolve(this.root,safeKey(key));await mkdir(dirname(file),{recursive:true});
    const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,text);await rename(tmp,file);
  }
  async list(prefix:string) {
    const all:string[]=[];
    const walk=async(dir:string,base='')=>{
      const entries=await readdir(dir,{withFileTypes:true}).catch((e:any)=>{if(e.code==='ENOENT')return [];throw e;});
      for(const entry of entries) {const key=base+entry.name;if(entry.isDirectory())await walk(join(dir,entry.name),key+'/');else if(!key.endsWith('.tmp')&&key.startsWith(prefix))all.push(key);}
    };await walk(this.root);return all;
  }
}
