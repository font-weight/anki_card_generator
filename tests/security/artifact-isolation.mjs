// Explicit post-build artifact check; no browser or networking. Run both builds first.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
for (const [folder,port,forbidden] of [['english-reader',8765,18765],['english-reader-test',18765,8765]]) {
 const manifest=JSON.parse(await readFile(`dist/${folder}/manifest.json`,'utf8'));
 const policy=manifest.content_security_policy.extension_pages;
 const connect=policy.split(';').find(x=>x.trim().startsWith('connect-src '));
 assert.ok(connect.includes(`http://127.0.0.1:${port}`));
 assert.ok(!connect.includes(`:${forbidden}`));
 assert.ok(!policy.includes('unsafe-eval'));
 assert.ok(!manifest.web_accessible_resources);
 if(port===18765){assert.ok(!connect.includes('localhost'));assert.ok(!connect.includes('[::1]'));assert.match(manifest.name,/isolated test/);}
 assert.equal(manifest.background.service_worker,'background.js');
 console.log(`${folder}: CSP loopback ${port} only; no opposite-port origin, eval or web-accessible resources`);
}
