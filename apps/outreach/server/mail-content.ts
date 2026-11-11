import { createHash } from 'node:crypto';
import type { OutgoingMail } from '../shared/email.js';

export function canonicalMailBody(body: string): string { return body.replace(/\r\n?/g, '\n').trimEnd(); }
export function outgoingMailHash(mail: Omit<OutgoingMail, 'contentHash'>): string {
  return createHash('sha256').update(JSON.stringify([
    mail.from.email.trim().toLowerCase(), mail.from.name, mail.to.trim().toLowerCase(),
    mail.subject, canonicalMailBody(mail.body), mail.rfcMessageId,
    mail.threadId, mail.inReplyTo, mail.references,
  ])).digest('hex');
}
