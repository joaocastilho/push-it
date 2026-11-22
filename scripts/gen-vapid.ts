// Generates a P-256 VAPID key pair for Web Push (RFC 8292)
const keyPair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const rawPub = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
const jwkPriv = await crypto.subtle.exportKey('jwk', keyPair.privateKey);

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const publicKey = toBase64Url(rawPub);
const privateKey = jwkPriv.d!;

console.log('# Paste into .dev.vars for local wrangler dev:\n');
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
console.log('\n# For production Cloudflare Workers, run:');
console.log('#   bunx wrangler secret put VAPID_PUBLIC_KEY');
console.log('#   bunx wrangler secret put VAPID_PRIVATE_KEY');
console.log('#   bunx wrangler secret put VAPID_SUBJECT');
