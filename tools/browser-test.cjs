// Headless UI acceptance checks; mocked launches never start real games.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const css = fs.readFileSync(path.join(root,'wasm/platform/platynite.css'));
const script = fs.readFileSync(path.join(root,'wasm/platform/platynite.js'));
const games = [
  {id:'11111111-1111-4111-8111-111111111111', name:'Alpha Adventure', installed:true, favorite:true, platforms:['PC'], description:'An installed adventure from your Playnite library.',playtime:100,lastActivity:'2026-10-26',artworkVersion:'1'},
  {id:'22222222-2222-4222-8222-222222222222', name:'Beta Worlds', installed:false, platforms:['PC'],description:'Available in your library, not installed on this PC.',playtime:0,artworkVersion:'1'},
  {id:'33333333-3333-4333-8333-333333333333', name:'Hidden Galaxy', installed:true, hidden:true, platforms:['Other'],description:'Hidden game.',playtime:0,artworkVersion:'1'},
  {id:'44444444-4444-4444-8444-444444444444', name:'Cloud Adventure', installed:false,canPlay:true,cloudProvider:'Xbox Cloud',platforms:['Xbox'],description:'A cloud-ready game needs no local game download.',playtime:500,artworkVersion:'1'}
];
const shell = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/platform/platynite.css"></head><body><header id="main-header"><nav></nav></header><script>
var Navigation={start(){},stop(){}};var Module={startStream(){}};var pairingCert='fixture';var myUniqueid='fixture';var hosts={};var api;var isInGame=false,isPairingInProgress=false;
function saveHosts(){} function stopPollingHosts(){} function showHosts(){} function snackbarLogLong(message){window._toast=message;}
function NvHTTP(){this.serverUid='fixture';this.paired=true;this.address='pc.test';this.currentGame=0;this.refreshServerInfoAtAddress=()=>Promise.resolve();this.refreshServerInfo=()=>Promise.resolve();this.getAppList=()=>Promise.resolve([{id:1,title:'Desktop'}]);}
function startGame(host,id){window._started={host:host.address,id};isInGame=true;}
</script><script src="/platform/platynite.js"></script></body></html>`;
const server = http.createServer((req,res) => {
  if (req.url==='/platform/platynite.css') {res.setHeader('Content-Type','text/css');res.end(css);}
  else if(req.url==='/platform/platynite.js') {res.setHeader('Content-Type','application/javascript');res.end(script);}
  else if(req.url==='/icon.png') {res.setHeader('Content-Type','image/png');res.end(fs.readFileSync(path.join(root,'res/icon.png')));}
  else {res.setHeader('Content-Type','text/html');res.end(shell);}
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const browser = await chromium.launch({headless:true, executablePath:process.env.BROWSER_EXE || undefined});
  const page = await browser.newPage({viewport:{width:1920,height:1080}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  let launches=[], offline=false;
  await page.route('http://pc.test/**',async route=>{
    if(offline) return route.abort();
    const req=route.request();
    const headers={'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'GET,POST,OPTIONS'};
    if(req.method()==='OPTIONS') return route.fulfill({status:204,headers});
    assert.equal(req.headers().authorization,'Bearer fixture-token');
    if(req.url().endsWith('/api/launch')) { launches.push(req.postDataJSON()); return route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify({status:'launch-requested'})}); }
    return route.fulfill({status:200,headers,contentType:'application/json',body:JSON.stringify({version:1,revision:'fixture-v1',host:'Playnite PC',games,addons:[{id:'startpage',name:'StartPage',view:'home'},{id:'gameactivity',name:'GameActivity',view:'activity'}]})});
  });
  try {
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.evaluate(()=>window.Platynite.configure({address:'http://pc.test',token:'fixture-token',sunshine:'pc.test'}));
    assert.equal(await page.locator('.pn-card').count(),3,'hidden games excluded by default');
    assert.equal(await page.locator('.pn-addon').count(),2,'only supported installed add-on adapters appear');
    await page.getByRole('button',{name:'GameActivity',exact:true}).click();assert.equal(await page.locator('#pn-heading').textContent(),'GameActivity');
    await page.locator('#pn-all').click();
    await page.locator('#pn-cloud').check();assert.equal(await page.locator('.pn-card').count(),1);assert.equal(await page.locator('#pn-play').isDisabled(),false);assert.match(await page.locator('#pn-play').textContent(),/Xbox Cloud/);
    await page.locator('#pn-cloud').uncheck();
    await page.locator('#pn-hidden').check(); assert.equal(await page.locator('.pn-card').count(),4);
    await page.locator('#pn-hidden').uncheck();
    await page.locator('#pn-installed').check(); assert.equal(await page.locator('.pn-card').count(),1);
    await page.locator('#pn-installed').uncheck();
    await page.locator('#pn-search').fill('Beta'); assert.equal(await page.locator('.pn-card').count(),1);
    assert.equal(await page.locator('#pn-play').isDisabled(),true,'uninstalled cannot launch');
    await page.locator('#pn-search').fill('Alpha');
    const size=await page.locator('.pn-cover').first().boundingBox();
    assert.ok(size.height/size.width>1.2 && size.height/size.width<1.5,'portrait covers retain their shape');
    await page.locator('#pn-play').click();
    await page.waitForFunction(()=>window._started);
    assert.equal(launches.length,0,'game cannot launch before stream connects');
    await page.evaluate(()=>window.Platynite.connected());
    await page.waitForTimeout(100);
    assert.equal(launches.length,1); assert.match(launches[0].requestId,/^[a-f0-9-]{36}$/);
    await page.evaluate(()=>window.Platynite.connected());await page.waitForTimeout(100);
    assert.equal(launches.length,1,'repeated connection event cannot relaunch');
    await page.evaluate(()=>{isInGame=false;window.Platynite.ended();}); await page.waitForTimeout(900);
    await page.locator('#pn-resume').click(); await page.waitForTimeout(100); await page.evaluate(()=>window.Platynite.connected());
    assert.equal(launches.length,1,'resume desktop never relaunches game');
    await page.evaluate(()=>{isInGame=false;window.Platynite.show();});
    await page.locator('#pn-search').fill('');
    await page.locator('.pn-card').first().focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('.pn-card').nth(1).evaluate(n=>n===document.activeElement),true,'remote moves between cards');
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('gamepadinputchanged',{detail:{changes:[{type:'button',index:14,pressed:true}]}})));
    assert.equal(await page.locator('.pn-card').first().evaluate(n=>n===document.activeElement),true,'gamepad D-pad reaches library');
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('gamepadinputchanged',{detail:{changes:[{type:'button',index:14,pressed:false},{type:'axis',index:0,value:1}]}})));
    assert.equal(await page.locator('.pn-card').nth(1).evaluate(n=>n===document.activeElement),true,'left stick navigates library');
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('gamepadinputchanged',{detail:{changes:[{type:'axis',index:0,value:0}]}})));
    offline=true; await page.locator('#pn-refresh').click(); await page.waitForTimeout(200);
    assert.equal(await page.locator('.pn-card').count(),3,'saved library stays visible offline');
    assert.equal(await page.locator('#pn-play').isDisabled(),true,'offline Play disabled');
    assert.match(await page.locator('#pn-status').textContent(),/saved library/);
    assert.deepEqual(errors,[]);
    console.log('PASS: full library, filters, uninstalled/offline states, remote/gamepad focus, deferred launch, duplicate prevention, resume');
    if(process.env.PREVIEW_CONNECTION){
      const live=JSON.parse(fs.readFileSync(process.env.PREVIEW_CONNECTION,'utf8'));
      await page.unroute('http://pc.test/**');
      await page.evaluate(value=>window.Platynite.configure(value),{address:live.Address,token:live.Token,sunshine:new URL(live.Address).hostname});
      await page.waitForTimeout(3500);
      const output=process.env.PREVIEW_OUTPUT;
      if(output) await page.screenshot({path:output});
      console.log('Live preview games:',await page.locator('.pn-card').count());
    }
  } finally {await browser.close();server.close();}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
