import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { Wallet } from 'ethers';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { address } from './config.js';

export class Vault {
  constructor(store) { this.store = store; this.unlocked = new Map(); }
  encrypt(value, password) {
    if (typeof password !== 'string' || password.length < 10 || password.length > 256) throw new Error('加密密码至少 10 字符');
    const salt = randomBytes(32), iv = randomBytes(12), key = scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try { const cipher = createCipheriv('aes-256-gcm', key, iv); const cipherText = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]); return { salt: salt.toString('hex'), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: cipherText.toString('hex') }; }
    finally { key.fill(0); }
  }
  decrypt(box, password) {
    if (typeof password !== 'string' || password.length > 256) throw new Error('密码错误');
    const key = scryptSync(password, Buffer.from(box.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    try { const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'hex')); d.setAuthTag(Buffer.from(box.tag, 'hex')); return JSON.parse(Buffer.concat([d.update(Buffer.from(box.ciphertext, 'hex')), d.final()]).toString('utf8')); }
    catch { throw new Error('密码错误或加密文件损坏'); } finally { key.fill(0); }
  }
  signer(chain, secret) {
    try {
      if (chain === 'bnb') return new Wallet(secret.startsWith('0x') ? secret : `0x${secret}`);
      let raw;
      if(secret.trim().startsWith('[')) { const a=JSON.parse(secret); if(!Array.isArray(a) || !a.every(v=>Number.isInteger(v)&&v>=0&&v<=255)) throw new Error('bytes'); raw=Uint8Array.from(a); }
      else raw=bs58.decode(secret.trim());
      if (raw.length !== 64 && raw.length !== 32) throw new Error('length');
      return raw.length === 64 ? Keypair.fromSecretKey(raw) : Keypair.fromSeed(raw);
    } catch { throw new Error('私钥格式无效：BNB 使用 hex，Solana 使用 base58 或字节数组'); }
  }
  importWallet(chain, input) {
    if (!['bnb', 'sol'].includes(chain)) throw new Error('未知链');
    if (input.type === 'readonly') {
      const wallet = { type: 'readonly', address: address(chain, input.address), updated: new Date().toISOString() };
      this.unlocked.delete(chain); this.store.set(`wallet:${chain}`, wallet); return this.publicWallet(chain);
    }
    if (input.type !== 'private' || typeof input.privateKey !== 'string') throw new Error('钱包类型或私钥无效');
    const signer = this.signer(chain, input.privateKey), addr = chain === 'bnb' ? signer.address : signer.publicKey.toBase58();
    this.store.set(`wallet:${chain}`, { type: 'private', address: addr, encrypted: this.encrypt({ privateKey: input.privateKey }, input.password), updated: new Date().toISOString() });
    this.unlocked.set(chain, signer); return this.publicWallet(chain);
  }
  unlock(chain, password) { const w = this.store.get(`wallet:${chain}`); if (!w?.encrypted) throw new Error('没有加密钱包'); this.unlocked.set(chain, this.signer(chain, this.decrypt(w.encrypted, password).privateKey)); return this.publicWallet(chain); }
  lock() { this.unlocked.clear(); }
  publicWallet(chain) { const w = this.store.get(`wallet:${chain}`); return w ? { type: w.type, address: w.address, updated: w.updated, unlocked: this.unlocked.has(chain) } : { type: 'missing', address: '', unlocked: false }; }
  saveOkx(input) {
    for (const k of ['apiKey', 'secretKey', 'passphrase', 'projectId']) if (typeof input[k] !== 'string' || !input[k].trim()) throw new Error('请填写完整 OKX 开发者凭据');
    const c = Object.fromEntries(['apiKey', 'secretKey', 'passphrase', 'projectId'].map(k => [k, input[k].trim()]));
    this.store.set('okx:vault', this.encrypt(c, input.password)); this.unlocked.set('okx', c);
  }
  unlockOkx(password) { const box = this.store.get('okx:vault'); if (!box) throw new Error('尚未配置 OKX'); this.unlocked.set('okx', this.decrypt(box, password)); }
  okxStatus() { return { configured: !!this.store.get('okx:vault'), unlocked: this.unlocked.has('okx') }; }
}
