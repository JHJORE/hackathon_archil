import test from 'node:test';
import assert from 'node:assert/strict';
import {runRfq} from '../server/run-input.js';
import {DEMO_RFQ} from '../server/fixtures.js';
test('empty Run is filled from the backend example',()=>{for(const value of [undefined,null,{}, {description:''}])assert.deepEqual(runRfq(value),DEMO_RFQ);});
test('partial RFQ preserves its product and never inherits example budgets or specs',()=>{
 const rfq=runRfq({description:'Steel beam',quantity:2});assert.equal(rfq.quantity,2);assert.equal(rfq.description,'Steel beam');assert.equal(rfq.targetUnitPrice,null);assert.equal(rfq.standard,null);
 assert.throws(()=>runRfq({description:'Bolts',quantity:-1}));
});
