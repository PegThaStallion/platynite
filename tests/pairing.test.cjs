const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
function hostFixture(challenge=true) {
  let pairCalls=0,authenticated=0;
  const context=vm.createContext({console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,window:{},navigator:{},sendMessage:async(method)=>{if(method==='pair'){pairCalls++;return 'sha256//fixture';}return 'challenge';}});
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../wasm/static/js/utils.js'),'utf8'),context);
  const host=new context.NvHTTP('192.0.2.10','fixture');host.serverMajorVersion=7;host._baseUrlHttps='https://192.0.2.10:47984';
  host.refreshServerInfo=async()=>{if(host.ppkstr){authenticated++;host.paired=true;}return true;};
  host._parseXML=()=>({find:()=>({html:()=>challenge?'1':'0'})});
  return {host,counts:()=>({pairCalls,authenticated})};
}
test('duplicate pairing actions share one handshake and verify authenticated server info',async()=>{
  const fixture=hostFixture();const [a,b]=await Promise.all([fixture.host.pair('1234'),fixture.host.pair('1234')]);
  assert.equal(a,true);assert.equal(b,true);assert.deepEqual(fixture.counts(),{pairCalls:1,authenticated:1});
  assert.equal(fixture.host._pairPromise,null);assert.equal(JSON.stringify(fixture.host).includes('_pairPromise'),false);
});
test('a rejected final challenge cannot be reported as successful pairing',async()=>{
  const fixture=hostFixture(false);await assert.rejects(fixture.host.pair('1234'),/did not finish pairing/);
  assert.equal(fixture.host.paired,false);assert.equal(fixture.host._pairPromise,null);
});
