// Encrypting small secrets for the database (a user's MCP headers, their own provider key).
// AES-256-GCM with ENCRYPTION_KEY: 32 random bytes as 64 hex characters or base64
// (`openssl rand -base64 32`). A value is "v1.<iv>.<tag>.<ciphertext>", base64url. Without a key,
// nothing is encrypted and callers refuse to store secrets, so a secret is never written in the clear.
'use strict';

const crypto = require('crypto');

function keyBytes(env = process.env) {
    const raw = String(env.ENCRYPTION_KEY || '').trim();
    if (!raw) return null;
    const bytes = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (bytes.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes: 64 hex characters or base64 (openssl rand -base64 32)');
    return bytes;
}

const available = () => { try { return keyBytes() !== null; } catch { return false; } };

function encrypt(plain) {
    const key = keyBytes();
    if (!key) throw new Error('ENCRYPTION_KEY is not set, so secrets cannot be stored');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

function decrypt(text) {
    const key = keyBytes();
    if (!key) throw new Error('ENCRYPTION_KEY is not set');
    const [v, iv, tag, body] = String(text).split('.');
    if (v !== 'v1' || !iv || !tag || body === undefined) throw new Error('not an encrypted value');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, available };
