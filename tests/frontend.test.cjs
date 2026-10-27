const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
test('all fork JavaScript parses', () => {
  for (const file of fs.readdirSync(path.join(root,'wasm/platform')).filter(f => f.endsWith('.js'))) {
    new vm.Script(fs.readFileSync(path.join(root,'wasm/platform',file),'utf8'), {filename:file});
  }
});
test('package and service identities cannot replace existing Moonlight', () => {
  const manifest = fs.readFileSync(path.join(root,'res/config.xml'),'utf8');
  assert.match(manifest,/id="PlatyNite1.Platynite" package="PlatyNite1"/);
  assert.match(manifest,/service id="PlatyNite1.service"/);
  assert.doesNotMatch(manifest,/MoonLightS/);
  const service = fs.readFileSync(path.join(root,'res/service/service.js'),'utf8');
  assert.match(service,/packageId \+ '.Platynite'/);
  assert.match(service,/listen\(8889,/);
});
test('stream success and termination notify the library', () => {
  const messages = fs.readFileSync(path.join(root,'wasm/platform/messages.js'),'utf8');
  assert.match(messages,/msg === 'Connection Established'\) \{\s+if \(window.Platynite\) window.Platynite.connected\(\)/);
  assert.match(messages,/msg.indexOf\('streamTerminated: '\) === 0\) \{\s+if \(window.Platynite\) window.Platynite.ended\(\)/);
});
