import type { WorkerSlot } from '../shared/types.js';
type Pending<T = unknown> = { jobId: string; kind: string; priority: number; order: number; task: () => Promise<T>; resolve: (v:T)=>void; reject:(e:unknown)=>void };
export class PriorityScheduler {
  readonly slots: WorkerSlot[];
  private pending: Pending<any>[] = [];
  private order = 0;
  private stopped = false;
  constructor(readonly concurrency = 3, private changed: () => void = () => {}) {
    this.slots = Array.from({length:concurrency}, (_,i)=>({slot:i+1,jobId:null,kind:null,status:'idle',startedAt:null,durationMs:null}));
  }
  get queue() { return this.pending.map(({jobId,kind,priority})=>({jobId,kind,priority})); }
  run<T>(jobId: string, kind: string, priority: number, task: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('Worker scheduler is shutting down'));
    return new Promise<T>((resolve,reject)=>{
      this.pending.push({jobId,kind,priority,order:this.order++,task,resolve,reject});
      this.pending.sort((a,b)=>a.priority-b.priority || a.order-b.order);
      this.changed(); this.drain();
    });
  }
  private drain() {
    for (const slot of this.slots) {
      if (slot.status === 'running') continue;
      const job = this.pending.shift(); if (!job) break;
      Object.assign(slot, {jobId:job.jobId,kind:job.kind,status:'running',startedAt:new Date().toISOString(),durationMs:null});
      const started=Date.now(); this.changed();
      Promise.resolve().then(job.task).then(value=>{slot.status='completed';job.resolve(value);},err=>{slot.status='error';job.reject(err);})
        .finally(()=>{slot.durationMs=Date.now()-started;this.changed();this.drain();});
    }
  }
  stop() { this.stopped=true; for(const job of this.pending.splice(0)) job.reject(new Error('Worker scheduler stopped')); this.changed(); }
}
