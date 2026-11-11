import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AppEvent, EventBus } from '../shared/types.js';
export class Events implements EventBus {
  readonly emitter = new EventEmitter();
  readonly recent: AppEvent[] = [];
  emit(type: string, message: string, data?: Record<string,unknown>, caseId?: string, supplierId?: string): AppEvent {
    const event: AppEvent = {id:randomUUID(),at:new Date().toISOString(),type,message,data,caseId,supplierId};
    this.recent.push(event);if(this.recent.length>300)this.recent.shift();
    this.emitter.emit('event',event);return event;
  }
}
