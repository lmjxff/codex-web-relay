// Isolated loopback-only fixture: real HTTP/WS/screen/Git/UI, scripted PTY.
// These controls exist only in this process, never in the production server.
const fs=require('node:fs');
const path=require('node:path');
const {fixture,cleanup,repository,git,loadWithMocks}=require('../helpers.cjs');
const directory=fixture();
const token='browser-test-access-credential-000000';
const controlKey='browser-fixture-control-only';
const port=process.env.RELAY_E2E_PORT||'43187';
repository(directory);
fs.writeFileSync(path.join(directory,'alpha.txt'),'original alpha\n');
fs.writeFileSync(path.join(directory,'beta.txt'),'original beta\n');
git(directory,'add','.');git(directory,'commit','-qm','Create browser fixture');
fs.writeFileSync(path.join(directory,'alpha.txt'),Array.from({length:40},(_,i)=>`alpha-${i} ${'wide-preview '.repeat(20)}`).join('\n')+'\n');
fs.writeFileSync(path.join(directory,'beta.txt'),'beta-only-change\n');
const cleanEnv={};
for(const key of ['PATH','Path','PATHEXT','SystemRoot','WINDIR','COMSPEC','TEMP','TMP','HOME','USERPROFILE'])if(process.env[key])cleanEnv[key]=process.env[key];
for(const key of Object.keys(process.env))delete process.env[key];
Object.assign(process.env,cleanEnv,{
  HOST:'127.0.0.1',PORT:port,CODEX_CWD:directory,
  RELAY_AUTH_TOKEN:token,RELAY_PIN:'',ENABLE_TUNNEL:'false',CF_HOSTNAME:'',CF_TUNNEL_TOKEN:'',
  AUTO_START_CODEX:'false',AUTO_OPEN_QR:'false',
});
process.chdir(directory);
let spawns=0,current,writes=[];
const pty={spawn(){
  spawns++;
  let text='',selected=1,menu=true,output='';
  const proc={pid:1000+spawns,write(data){
    writes.push(data);
    if(data==='\x1b[A'||data==='\x1b[B'){selected=data.endsWith('B')?2:1;render();return;}
    if(data==='\t'){selected=selected===1?2:1;render();return;}
    text+=data;
    if(/[\r\n]/.test(text)){
      const command=text.trim();text='';
      menu=false;
      output=command?`Received: ${command}`:`Working: ${selected===1?'approved':'rejected'}`;
      render();
    }
  },resize(){},kill(){this.exit?.({exitCode:0});},
  onData(callback){this.data=callback;queueMicrotask(render);},onExit(callback){this.exit=callback;}};
  function render(){
    proc.data?.('\x1b[H\x1b[2J'+(menu?`Session ${spawns}\r\nChoose an action:\r\n${selected===1?'>':' '} 1. Yes, proceed\r\n${selected===2?'>':' '} 2. No, cancel\r\nPress Enter to confirm\r\n`:`${output}\r\n`));
  }
  current=proc;return proc;
}};
const loaded=loadWithMocks('index.js',{'node-pty':pty,'./tunnel':{stopActiveTunnel(){}}},'exports.fixture={app,wss,spawnCodexPty};');
const {app,wss,spawnCodexPty}=loaded.fixture;
app.get('/__test/ready',(_req,res)=>res.json({ready:true}));
app.use('/__test',(req,res,next)=>req.get('x-fixture-key')===controlKey?next():res.sendStatus(403));
app.post('/__test/reset',(_req,res)=>{writes=[];spawnCodexPty();res.json({spawns});});
app.get('/__test/stats',(_req,res)=>res.json({spawns,writes}));
app.post('/__test/disconnect',(_req,res)=>{for(const ws of wss.clients)ws.close(1012,'Fixture reconnect');res.json({ok:true});});
app.post('/__test/progress',(_req,res)=>{current.data('\x1b[H\x1b[2JRecovered while offline\r\n');res.json({ok:true});});
app.post('/__test/end',(_req,res)=>{current.exit({exitCode:0});res.json({ok:true});});
loaded.server.listen(Number(process.env.PORT),'127.0.0.1');
let stopping=false;
function stop(){
  if(stopping)return;stopping=true;
  for(const ws of wss.clients)ws.terminate();
  wss.close();loaded.server.closeAllConnections();
  loaded.server.close(()=>{process.chdir(path.dirname(directory));cleanup(directory);process.exit(0);});
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
