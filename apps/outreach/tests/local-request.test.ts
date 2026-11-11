import test from 'node:test';
import assert from 'node:assert/strict';
import { localRequestGuard } from '../server/local-request.js';

function request(headers: Record<string,string>, method='POST', json=true) {
  let status=200, allowed=false;
  const req={path:'/api/cases/one/email-drafts/rfq-one/approve-send',method,get:(key:string)=>headers[key],is:()=>json};
  const res={status:(code:number)=>{status=code;return res;},json:()=>res,setHeader:()=>res};
  localRequestGuard(4310)(req as any,res as any,()=>{allowed=true;});
  return {status,allowed};
}
test('reviewed email mutations accept the dashboard and local JSON clients',()=>{
  assert.equal(request({host:'127.0.0.1:4310',origin:'http://127.0.0.1:4310'}).allowed,true);
  assert.equal(request({host:'localhost:4310',origin:'http://localhost:4311'}).allowed,true);
  assert.equal(request({host:'127.0.0.1:4310'}).allowed,true);
});
test('reviewed email mutations reject cross-origin forms and rebound hosts',()=>{
  assert.equal(request({host:'127.0.0.1:4310',origin:'https://evil.example'}).status,403);
  assert.equal(request({host:'127.0.0.1:4310',origin:'http://localhost:9999'}).status,403);
  assert.equal(request({host:'evil.example:4310'}).status,403);
  assert.equal(request({host:'127.0.0.1:4310'},'POST',false).status,415);
  assert.equal(request({host:'127.0.0.1:4310'},'GET',false).allowed,true);
});
