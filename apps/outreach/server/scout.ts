import { createHash } from 'node:crypto';
import { Archil, type Disk } from 'disk';
import type { ScoutItem, ScoutOverview } from '../shared/scout.js';
import type { Rfq, Store } from '../shared/types.js';

const MAX_ITEMS = 50;
const INDEX_PATH = 'rfqs/latest.json';
const MAX_INDEX_BYTES = 1_000_000;
const MAX_RECORD_BYTES = 128_000;
const SAFE_ID = /^rfq-[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/;
type JsonObject = Record<string, unknown>;
type ReadStore = Pick<Store, 'getText'>;
type IndexEntry = { id: string; path: string };

export class ScoutError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) { super(message); }
}

/** This adapter deliberately exposes no mutation or execution methods. */
class ArchilScoutReader implements ReadStore {
  private current: { key: string; region: string; disk: Promise<Disk> } | null = null;
  constructor(private readonly diskId: string) {}
  private disk(): Promise<Disk> {
    const key = process.env.ARCHIL_API_KEY;
    if (!key) throw new ScoutError('scout_unconfigured', 'Archil access is not configured.', 428);
    const region = process.env.ARCHIL_REGION || 'aws-us-east-1';
    if (!this.current || key !== this.current.key || region !== this.current.region) {
      const disk = new Archil({ apiKey: key, region }).disks.get(this.diskId);
      this.current = { key, region, disk };
      void disk.catch(() => { if (this.current?.disk === disk) this.current = null; });
    }
    return this.current.disk;
  }
  async getText(path: string): Promise<string | null> {
    if (path !== INDEX_PATH && !/^rfqs\/open\/rfq-[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}\.json$/.test(path)) {
      throw new ScoutError('scout_invalid_path', 'Unsupported scout source path.', 400);
    }
    try { return new TextDecoder().decode(await (await this.disk()).getObject(path)); }
    catch (error: unknown) {
      if (error instanceof ScoutError) throw error;
      const value = error as { status?: number; statusCode?: number; code?: string };
      if (value.status === 404 || value.statusCode === 404 || value.code === 'NoSuchKey' || value.code === 'NotFound') return null;
      throw new ScoutError('scout_unavailable', 'The RFQ scout disk could not be read. Check local Archil access.');
    }
  }
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}
function text(value: unknown, max = 2000): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}
function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value ? value : null;
}
function sourceUrl(value: unknown): string | null {
  const input = text(value, 4000);
  if (!input) return null;
  try {
    const parsed = new URL(input);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch { return null; }
}
function parse(raw: string | null, max: number): unknown {
  if (raw === null) throw new ScoutError('scout_missing_source', 'The published scout source is unavailable.', 404);
  if (Buffer.byteLength(raw, 'utf8') > max) throw new ScoutError('scout_source_too_large', 'The published scout source exceeds the review size limit.');
  try { return JSON.parse(raw); }
  catch { throw new ScoutError('scout_invalid_source', 'The published scout source is not valid JSON.'); }
}

function mapRecord(raw: string, entry: IndexEntry, diskId: string, diskName: string, now: Date): ScoutItem {
  const record = object(parse(raw, MAX_RECORD_BYTES));
  if (!record || record.id !== entry.id || !text(record.title)) throw new ScoutError('scout_invalid_record', 'A scout record does not match its published identity.');
  const title = text(record.title)!;
  const buyer = object(record.buyer);
  const delivery = object(record.delivery);
  const dates = object(record.dates);
  const dueDate = isoDate(dates?.response_due);
  const source = sourceUrl(record.source_url);
  const warnings = ['Review the original solicitation and complete missing product details before sourcing.'];
  const rfq: Partial<Rfq> = {};
  const lines = Array.isArray(record.line_items) ? record.line_items : [];
  const line = lines.length === 1 ? object(lines[0]) : null;
  if (line) {
    const product = text(line.product), spec = text(line.spec);
    rfq.description = [product || title, spec].filter(Boolean).join(' — ').slice(0, 2000);
    const unit = text(line.unit, 80)?.toLowerCase();
    if (unit && /^(ea|each|unit|units|piece|pieces|pcs|pc)$/.test(unit) && Number.isSafeInteger(line.quantity) && Number(line.quantity) > 0) {
      rfq.quantity = Number(line.quantity);
    } else warnings.push('Quantity needs review: only a positive whole number with an explicit each/piece unit can be imported.');
    const standards = Array.isArray(record.required_standards) ? record.required_standards.map(value => text(value)).filter((value): value is string => value !== null) : [];
    if (standards.length) rfq.standard = standards.join('; ').slice(0, 2000);
  } else {
    rfq.description = title;
    warnings.push('This solicitation has multiple or unspecified product lines. Select one product and enter its quantity and specifications; quantities are not combined.');
  }
  const destination = text(delivery?.location);
  const terms = text(delivery?.terms);
  if (destination) rfq.destination = destination;
  if (terms) rfq.incoterm = terms;
  // The publication's bid deadline is never substituted for the requested delivery date.
  if (dueDate) warnings.push('The response deadline is a bid deadline, not the required delivery date.');
  if (dueDate && dueDate < now.toISOString().slice(0, 10)) warnings.push('The published response date has passed. Verify whether this opportunity is still open.');
  if (record.status !== 'open' || record.is_open !== true) warnings.push('The source does not confirm this solicitation is currently open.');
  if (!source) warnings.push('No supported public source URL is available.');
  if (record.contact || record.submission) warnings.push('Buyer and submission contacts are source context, not manufacturer outreach recipients.');
  const missing: Array<[keyof Rfq, string]> = [['standard', 'standard'], ['size', 'size'], ['grade', 'grade'], ['finish', 'finish'], ['quantity', 'quantity'], ['currency', 'currency'], ['incoterm', 'delivery terms'], ['destination', 'destination'], ['targetUnitPrice', 'target price'], ['maxUnitPrice', 'maximum price']];
  warnings.push(`Complete before sourcing: ${missing.filter(([key]) => rfq[key] === undefined).map(([, label]) => label).join(', ')}.`);
  return {
    id: entry.id, title, reference: text(record.solicitation_number), buyer: text(buyer?.agency), dueDate,
    sourceUrl: source, summary: text(record.summary) || '', rfq, warnings,
    source: { id: entry.id, kind: 'archil', diskId, diskName, path: entry.path,
      sha256: createHash('sha256').update(raw, 'utf8').digest('hex'), revision: text(record.found_in_run) || text(record.found_at) },
  };
}

export type ScoutServiceOptions = { store?: ReadStore; diskId?: string; diskName?: string; now?: () => Date; env?: () => NodeJS.ProcessEnv };

/** Reads published scout records; importing into outreach is a separate, reviewed operation. */
export class ScoutService {
  private readonly store: ReadStore;
  private readonly diskId: string;
  private readonly diskName: string;
  private readonly now: () => Date;
  constructor(options: ScoutServiceOptions = {}) {
    this.diskId = (options.diskId ?? (options.env?.() ?? process.env).SCOUT_DISK_ID ?? '').trim();
    this.diskName = options.diskName || 'rfq-scout';
    this.store = options.store || new ArchilScoutReader(this.diskId);
    this.now = options.now || (() => new Date());
  }
  private async index(): Promise<{ entries: IndexEntry[]; limited: boolean }> {
    if (!this.diskId) throw new ScoutError('scout_unconfigured', 'Configure SCOUT_DISK_ID to read an RFQ Scout disk. The fictional sample remains available.', 428);
    const records = parse(await this.store.getText(INDEX_PATH), MAX_INDEX_BYTES);
    if (!Array.isArray(records)) throw new ScoutError('scout_invalid_index', 'The scout latest index must be an array.');
    const entries: IndexEntry[] = [];
    const seen = new Set<string>();
    // A source record is addressable only when a safe ID appears in the current published index.
    for (const candidate of records) {
      const record = object(candidate);
      if (!record || typeof record.id !== 'string' || !SAFE_ID.test(record.id) || record.status !== 'open' || seen.has(record.id)) continue;
      seen.add(record.id);
      if (entries.length < MAX_ITEMS) entries.push({ id: record.id, path: `rfqs/open/${record.id}.json` });
    }
    return { entries, limited: seen.size > MAX_ITEMS };
  }
  async overview(): Promise<ScoutOverview> {
    const checkedAt = this.now().toISOString();
    const disk: ScoutOverview['disk'] = { id: this.diskId, name: this.diskName, connected: false, access: 'read-only' };
    try {
      const index = await this.index();
      disk.connected = true;
      const results: Array<ScoutItem | null> = Array(index.entries.length).fill(null);
      let next = 0, failed = 0;
      await Promise.all(Array.from({ length: Math.min(4, index.entries.length) }, async () => {
        for (;;) {
          const position = next++;
          if (position >= index.entries.length) return;
          const entry = index.entries[position]!;
          try {
            const raw = await this.store.getText(entry.path);
            if (raw === null) throw new ScoutError('scout_missing_source', 'Source unavailable.', 404);
            results[position] = mapRecord(raw, entry, this.diskId, this.diskName, new Date(checkedAt));
          } catch { failed++; }
        }
      }));
      return { checkedAt, disk, items: results.filter((value): value is ScoutItem => value !== null), limited: index.limited,
        error: failed ? `${failed} published scout record${failed === 1 ? '' : 's'} could not be read or validated.` : null };
    } catch (error: unknown) {
      return { checkedAt, disk, items: [], limited: false,
        error: error instanceof ScoutError ? error.message : 'The RFQ scout feed could not be read. Check local Archil access.' };
    }
  }
  async resolve(id: string): Promise<{ item: ScoutItem; raw: string }> {
    if (!SAFE_ID.test(id)) throw new ScoutError('scout_invalid_id', 'Invalid scout source ID.', 400);
    try {
      const index = await this.index();
      const entry = index.entries.find(candidate => candidate.id === id);
      if (!entry) throw new ScoutError('scout_not_found', 'This source is not in the current scout review list.', 404);
      const raw = await this.store.getText(entry.path);
      if (raw === null) throw new ScoutError('scout_missing_source', 'The published scout source is unavailable.', 404);
      return { item: mapRecord(raw, entry, this.diskId, this.diskName, this.now()), raw };
    } catch (error: unknown) {
      if (error instanceof ScoutError) throw error;
      throw new ScoutError('scout_unavailable', 'The RFQ scout source could not be read. Check local Archil access.');
    }
  }
}
