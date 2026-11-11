// Storage for the voice app. Local files under apps/voice/data/ by default.
// Set VOICE_ARCHIL_DISK_ID to store on a dedicated Archil disk instead. It deliberately does
// NOT read ARCHIL_DISK_ID or SCOUT_DISK_ID, so it can never write to the outreach or scout disks.
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "data");

export async function openStore() {
  if (process.env.VOICE_ARCHIL_DISK_ID && process.env.ARCHIL_API_KEY) return ArchilStore.open(process.env.VOICE_ARCHIL_DISK_ID);
  return new LocalStore(ROOT);
}

class LocalStore {
  constructor(root) { this.root = root; this.kind = `local (${root})`; }
  p(key) { return path.join(this.root, key); }
  async get(key) { try { return await fs.readFile(this.p(key), "utf8"); } catch { return null; } }
  async put(key, body) { await fs.mkdir(path.dirname(this.p(key)), { recursive: true }); await fs.writeFile(this.p(key), body); }
  async append(key, body) { await fs.mkdir(path.dirname(this.p(key)), { recursive: true }); await fs.appendFile(this.p(key), body); }
  async list(prefix) {
    try { return (await fs.readdir(this.p(prefix))).map((f) => path.posix.join(prefix, f)); } catch { return []; }
  }
  async exists(key) { return (await this.get(key)) !== null; }
  async del(key) { await fs.rm(this.p(key), { force: true }); }
}

class ArchilStore {
  static async open(diskId) {
    const archil = await import("disk");
    archil.configure({ apiKey: process.env.ARCHIL_API_KEY, region: process.env.ARCHIL_REGION || "aws-us-east-1" });
    const s = new ArchilStore();
    s.disk = await archil.getDisk(diskId);
    s.kind = `archil disk ${s.disk.id} (${s.disk.name})`;
    return s;
  }
  async get(key) {
    if (!(await this.disk.objectExists(key))) return null;
    return new TextDecoder().decode(await this.disk.getObject(key));
  }
  async put(key, body) {
    const type = key.endsWith(".json") ? "application/json" : key.endsWith(".pdf") ? "application/pdf" : "text/plain";
    await this.disk.putObject(key, body, type);
  }
  async append(key, body) { await this.disk.appendObject(key, body, "text/plain"); }
  async list(prefix) {
    const res = await this.disk.listObjects(prefix.endsWith("/") ? prefix : prefix + "/");
    const files = (res.objects || []).map((o) => o.key);
    const dirs = (res.commonPrefixes || []).map((p) => (typeof p === "string" ? p : p.prefix).replace(/\/$/, ""));
    return [...files, ...dirs].filter((k) => k && !k.endsWith("/"));
  }
  async exists(key) { return this.disk.objectExists(key); }
  async del(key) { await this.disk.deleteObject(key); }
}
