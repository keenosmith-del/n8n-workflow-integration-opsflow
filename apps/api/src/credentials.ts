import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
function key() {
  const k = Buffer.from(process.env.CREDENTIAL_ENCRYPTION_KEY || '', 'hex');
  if (k.length !== 32) throw new Error('CREDENTIAL_ENCRYPTION_KEY must contain 64 hex characters');
  return k;
}
export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  return [
    iv.toString('hex'),
    Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]).toString('hex'),
    cipher.getAuthTag().toString('hex'),
  ]
    .filter(Boolean)
    .join(':');
}
export function decrypt(value: string) {
  const [iv, data, tag] = value.split(':');
  const cipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'hex'));
  cipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([cipher.update(Buffer.from(data, 'hex')), cipher.final()]).toString();
}
