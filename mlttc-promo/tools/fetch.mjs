// Minimal redirect-following downloader (Node TLS, no schannel/curl involved).
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [url, out] = process.argv.slice(2);

async function go(u, depth = 0) {
  if (depth > 6) throw new Error('too many redirects');
  const res = await fetch(u, { redirect: 'manual' });
  if (res.status >= 300 && res.status < 400) {
    return go(new URL(res.headers.get('location'), u).href, depth + 1);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${u}`);
  const total = Number(res.headers.get('content-length') || 0);
  let seen = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', c => {
    seen += c.length;
    if (total && Math.random() < 0.02) console.log(`${((seen / total) * 100).toFixed(1)}%`);
  });
  await pipeline(body, createWriteStream(out));
  console.log(`done ${out} (${(seen / 1048576).toFixed(1)} MB, expected ${(total / 1048576).toFixed(1)} MB)`);
}

go(url).catch(e => { console.error(String(e.message || e)); process.exit(1); });
