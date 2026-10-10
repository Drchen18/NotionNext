import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, openSync, writeFileSync, readFileSync, unlinkSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaults, json } from './config.js';

export class Store {
  constructor(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
    this.lockPath=join(dir,'instance.lock');this.lockValue=JSON.stringify({pid:process.pid,nonce:randomUUID()});
    try{this.lockFd=openSync(this.lockPath,'wx',0o600);}catch(e){
      if(e.code!=='EEXIST')throw e;
      let owner;try{owner=JSON.parse(readFileSync(this.lockPath,'utf8'));}catch{throw new Error('本机实例锁无法读取，请核对数据目录');}
      if(!Number.isInteger(owner.pid)||owner.pid<=0)throw new Error('实例锁格式错误，请核对数据目录');
      let alive=true;try{process.kill(owner.pid,0);}catch(err){if(err.code==='ESRCH')alive=false;}
      if(alive)throw new Error('该数据目录已有运行实例，禁止同时执行两套交易服务');
      unlinkSync(this.lockPath);this.lockFd=openSync(this.lockPath,'wx',0o600);
    }
    writeFileSync(this.lockFd,this.lockValue);
    this.db = new DatabaseSync(join(dir, 'archive.sqlite')); chmodSync(join(dir, 'archive.sqlite'), 0o600);
    this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, job TEXT NOT NULL, at TEXT NOT NULL, state TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, created TEXT NOT NULL, updated TEXT NOT NULL, text TEXT NOT NULL);`);
    if (!this.get('config')) this.set('config', defaults);
    const saved=this.get('config'), migrated={...defaults,...saved};
    for(const key of ['bnb','sol','risk','bridge','paper']) migrated[key]={...defaults[key],...saved[key]};
    this.set('config',migrated);
    for (const row of this.db.prepare("SELECT id,state FROM jobs WHERE state NOT IN ('COMPLETED','FAILED','RECOVERY_REQUIRED','ACKNOWLEDGED')").all()) this.transition(row.id, 'RECOVERY_REQUIRED', { previousState: row.state, message:'重启恢复：未结算任务禁止自动重发，须核对链上状态' });
    const open = this.db.prepare("SELECT id FROM jobs WHERE state='RECOVERY_REQUIRED'").all();
    if (open.length) this.set('pause', { at: new Date().toISOString(), reason: '重启检测到未结算交易，禁止自动重发；请核对交易哈希和两侧余额', jobs: open.map(j => j.id) });
    // Automation never restarts itself, even if the machine crashed while armed.
    this.set('automation', { arbitrage: false, rebalance: false });
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO kv VALUES (?,?)').run(key, json(value)); return value; }
  create(kind, body, id = randomUUID()) {
    const at = new Date().toISOString();
    this.db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)').run(id, kind, 'CREATED', at, at, json(body));
    this.transition(id, 'CREATED', { message: '任务创建，模式及报价已保存' }); return this.job(id);
  }
  job(id) { const r = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id); if (!r) return null; return { ...JSON.parse(r.body), id: r.id, kind: r.kind, state: r.state, created: r.created, updated: r.updated, events: this.db.prepare('SELECT at,state,detail FROM events WHERE job=? ORDER BY id').all(id).map(e => ({ ...e, detail: JSON.parse(e.detail) })) }; }
  transition(id, state, detail = {}, patch = {}) {
    const row = this.db.prepare('SELECT body FROM jobs WHERE id=?').get(id); if (!row) throw new Error('任务不存在');
    const at = new Date().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE jobs SET state=?,updated=?,body=? WHERE id=?').run(state, at, json({ ...JSON.parse(row.body), ...patch }), id);
      this.db.prepare('INSERT INTO events (job,at,state,detail) VALUES (?,?,?,?)').run(id, at, state, json(detail)); this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  list(page = 1, size = 10) {
    const total = this.db.prepare('SELECT count(*) AS n FROM jobs').get().n;
    return { total, page, items: this.db.prepare('SELECT id FROM jobs ORDER BY created DESC LIMIT ? OFFSET ?').all(size, (page - 1) * size).map(r => this.job(r.id)) };
  }
  limits(mode) { return this.get(`limits:${mode}`, { executions: 0, total: 0 }); }
  reserve(mode, amount) { const r = this.limits(mode); this.set(`limits:${mode}`, { executions: r.executions + 1, total: r.total + amount }); }
  notes(page = 1) { return { page, total: this.db.prepare('SELECT count(*) AS n FROM notes').get().n, items: this.db.prepare('SELECT * FROM notes ORDER BY created DESC LIMIT 8 OFFSET ?').all((page - 1) * 8) }; }
  addNote(text) { if (typeof text !== 'string' || !text.trim() || text.length > 20000) throw new Error('备忘录长度为 1–20000 字符'); const id = randomUUID(), at = new Date().toISOString(); this.db.prepare('INSERT INTO notes VALUES (?,?,?,?)').run(id, at, at, text.trim()); return id; }
  close() { this.db.close();closeSync(this.lockFd);try{if(readFileSync(this.lockPath,'utf8')===this.lockValue)unlinkSync(this.lockPath);}catch{/* preserve another instance's lock */} }
}
