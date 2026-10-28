// Inspect only Platynite's own Tizen page. Credentials are read locally, never logged.
const fs = require('node:fs');
async function main() {
  const endpoint = process.env.PLATYNITE_INSPECTOR;
  if(!endpoint) throw new Error('Set PLATYNITE_INSPECTOR to the TV inspector HTTP endpoint');
  const targets = await (await fetch(endpoint+'/json')).json();
  const target = targets.find(t=>t.title==='Platynite');
  if(!target) throw new Error('Platynite inspector target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl); const pending=new Map();let nextId=1;
  await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  ws.onmessage=e=>{const data=JSON.parse(e.data);if(pending.has(data.id)){pending.get(data.id)(data);pending.delete(data.id);}else if(process.env.TV_CONSOLE && data.method==='Runtime.consoleAPICalled') {const text=(data.params.args||[]).filter(a=>typeof a.value==='string').map(a=>a.value).join(' ').replace(/clientcert=[^&\s]+/g,'clientcert=[public certificate]');if(/\bpair\b|Paired host|pair\?|Failed|Certificate mismatch|pairingDialog/i.test(text)) console.log('TV console:',text.slice(0,2000));}};
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=nextId++;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Inspector request timed out: '+method));},20000);pending.set(id,result=>{clearTimeout(timer);if(result.error)reject(new Error(result.error.message));else resolve(result.result);});ws.send(JSON.stringify({id,method,params}));});
  try {
    if(process.env.TV_CONSOLE) await send('Runtime.enable');
    if(process.env.PREVIEW_CONNECTION){
      const config=JSON.parse(fs.readFileSync(process.env.PREVIEW_CONNECTION,'utf8'));
      const value={address:config.Address,token:config.Token,sunshine:new URL(config.Address).hostname};
      await send('Runtime.evaluate',{expression:'window.Platynite.configure('+JSON.stringify(value)+')',awaitPromise:true,returnByValue:true});
    }
    const expression=process.env.TV_EXPRESSION_FILE ? fs.readFileSync(process.env.TV_EXPRESSION_FILE,'utf8') :
      `JSON.stringify({title:document.title,library:!!window.Platynite,visible:window.Platynite&&window.Platynite.isVisible(),games:document.querySelectorAll('.pn-card').length,status:document.querySelector('#pn-status')&&document.querySelector('#pn-status').textContent,engine:typeof Module !== 'undefined' && typeof Module.startStream === 'function',pairingReady:typeof pairingCert !== 'undefined' && !!pairingCert,focused:document.activeElement.id,appId:tizen.application.getAppInfo().id})`;
    const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
    if(result.exceptionDetails) console.log(JSON.stringify({exception:result.exceptionDetails}));else console.log(result.result.value);
    if(process.env.TV_SCREENSHOT){const screenshot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.TV_SCREENSHOT,Buffer.from(screenshot.data,'base64'));console.log('Saved TV screenshot');}
  } finally {ws.close();}
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
