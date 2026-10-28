const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {project}=require('./helpers.cjs');

async function browser({delayedWrites=false,preferences={},browserLanguage='zh-CN',fetchImpl,autoPong=true}={}){
  const elements=new Map(),sockets=[],timers=[],intervals=[],writes=[],actions=new Map(),tabs=new Map();
  const documentEvents={},windowEvents={};
  function element(){const node={value:'',textContent:'',hidden:false,disabled:false,children:[],scrollTop:0,scrollLeft:0,htmlWrites:0,
    classList:{add(){},remove(){},toggle(){}},listeners:{},addEventListener(type,fn){this.listeners[type]=fn;},
    open:false,showModal(){this.open=true;},close(){this.open=false;},
    querySelectorAll(){return [];},appendChild(child){this.children.push(child);},prepend(child){this.children.unshift(child);},setAttribute(name,value){this[name]=value;},getAttribute(name){return this[name];},focus(){}};
    let html='';Object.defineProperty(node,'innerHTML',{get(){return html;},set(value){html=value;this.children=[];this.scrollTop=0;this.scrollLeft=0;this.htmlWrites++;this.onHtmlChange?.(value);}});
    return node;
  }
  for(const match of fs.readFileSync(path.join(project,'public','index.html'),'utf8').matchAll(/data-action="([^"]+)"/g)) {
    const button=element();button['data-action']=match[1];actions.set(match[1],button);
  }
  for(const name of ['terminal','diff']){const tab=element();tab['data-tab']=name;tabs.set(name,tab);}
  const document={visibilityState:'visible',addEventListener(type,fn){documentEvents[type]=fn;},documentElement:{lang:''},getElementById(id){if(!elements.has(id))elements.set(id,element());return elements.get(id);},
    querySelectorAll(selector){
      if(selector==='[data-action]')return [...actions.values()];
      if(selector==='.tab-btn')return [...tabs.values()];
      if(selector==='[data-language-select]')return ['auth-language','ui-language'].map(id=>this.getElementById(id));
      return [];
    },createElement:element,title:'Relay'};
  const terminal={cols:80,rows:24,output:'',resets:0,loadAddon(){},open(){},onData(){},clear(){},
    reset(){this.output='';this.resets++;},resize(cols,rows){this.cols=cols;this.rows=rows;},
    write(data,callback){const complete=()=>{this.output+=data;callback?.();};delayedWrites?writes.push(complete):complete();}};
  class Socket {
    static OPEN=1;
    static CONNECTING=0;
    constructor(){this.readyState=0;this.listeners={};this.sent=[];this.heartbeats=[];sockets.push(this);}
    addEventListener(type,fn){this.listeners[type]=fn;}
    send(raw){const message=JSON.parse(raw);if(message.type==='ping'){this.heartbeats.push(message);if(autoPong)this.message({type:'pong',id:message.id});}else this.sent.push(message);}
    close(){this.readyState=3;this.dispatch('close');}
    dispatch(type,data){this.listeners[type]?.(data);}
    open(){this.readyState=1;this.dispatch('open');}
    message(message){this.dispatch('message',{data:JSON.stringify(message)});}
  }
  const storage=new Map([['codex_relay_auth_token','synthetic-browser-test-credential'],...Object.entries(preferences)]);
  const context={document,URLSearchParams,AbortController,WebSocket:Socket,navigator:{language:browserLanguage},
    localStorage:{getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    setTimeout(fn,delay){const timer={fn,delay};timers.push(timer);return timer;},clearTimeout(timer){if(timer)timer.cancelled=true;},
    setInterval(fn,delay){const timer={fn,delay};intervals.push(timer);return timer;},clearInterval(timer){if(timer)timer.cancelled=true;},
    fetch:fetchImpl|| (async url=>({ok:true,status:200,json:async()=>url.includes('auth')?{ok:true,cwd:'/synthetic'}:{ok:true,files:[]}})),
    window:{location:{hostname:'localhost',host:'localhost:3210',protocol:'http:',search:'',pathname:'/',hash:''},
      history:{replaceState(){}},addEventListener(type,fn){windowEvents[type]=fn;},Terminal:function(options){terminal.options=options;return terminal;},FitAddon:{FitAddon:function(){this.proposeDimensions=()=>({cols:120,rows:35});}}}};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(project,'public','i18n.js'),'utf8'),context);
  vm.runInContext(fs.readFileSync(path.join(project,'public','app.js'),'utf8'),context);
  await new Promise(resolve=>setImmediate(resolve));
  return {elements,sockets,timers,intervals,terminal,writes,actions,tabs,storage,document,documentEvents,windowEvents,i18n:context.window.RelayI18n,submit(){elements.get('prompt-form').listeners.submit({preventDefault(){}});}};
}

const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fireTimer(page,delay){const timer=page.timers.findLast(item=>item.delay===delay&&!item.cancelled);assert(timer,`Missing timer ${delay}`);timer.cancelled=true;timer.fn();}

test('a connection becomes healthy only after its pong and a lost heartbeat reconnects without resending input',async()=>{
  const page=await browser({autoPong:false}),socket=page.sockets[0];socket.open();
  assert.equal(socket.heartbeats.length,1);assert(page.actions.get('enter').disabled);
  page.elements.get('prompt-input').value='retained draft';page.submit();assert.equal(socket.sent.length,0);
  socket.message({type:'pong',id:'wrong'});assert(page.actions.get('enter').disabled);
  socket.message({type:'pong',id:socket.heartbeats[0].id});assert(!page.actions.get('enter').disabled);
  fireTimer(page,15000);fireTimer(page,10000);
  assert.equal(socket.readyState,3);assert(page.actions.get('enter').disabled);
  assert.equal(page.elements.get('prompt-input').value,'retained draft');
  fireTimer(page,2000);assert.equal(page.sockets.length,2);assert.equal(page.sockets[1].sent.length,0);
  socket.message({type:'pong',id:socket.heartbeats.at(-1).id});assert(page.actions.get('enter').disabled);
});

test('failed connections back off to 30 seconds and a healthy pong resets the delay',async()=>{
  const page=await browser({autoPong:false});
  for(const delay of [2000,4000,8000,16000,30000,30000]){
    fireTimer(page,10000);fireTimer(page,delay);
  }
  const socket=page.sockets.at(-1);socket.open();socket.message({type:'pong',id:socket.heartbeats[0].id});
  socket.close();fireTimer(page,2000);
  assert.equal(page.sockets.length,8);
});

test('returning from the background checks liveness and restores a snapshot without replaying commands',async()=>{
  const page=await browser({autoPong:false}),socket=page.sockets[0];socket.open();
  socket.message({type:'pong',id:socket.heartbeats[0].id});
  page.elements.get('prompt-input').value='uncertain task';page.submit();
  page.document.visibilityState='hidden';page.documentEvents.visibilitychange();
  assert(page.actions.get('enter').disabled);
  page.document.visibilityState='visible';page.documentEvents.visibilitychange();page.windowEvents.pageshow();
  assert.equal(socket.heartbeats.length,2);assert(page.actions.get('enter').disabled);
  socket.message({type:'pong',id:socket.heartbeats[1].id});
  assert.equal(socket.sent.filter(message=>message.type==='sync').length,1);
  assert.equal(socket.sent.filter(message=>message.type==='input').length,1);
  assert(!socket.sent.some(message=>['action','restart'].includes(message.type)));
  socket.message({type:'history',cols:80,rows:24,data:'current screen'});
  assert.equal(page.terminal.output,'current screen');assert.equal(page.elements.get('prompt-input').value,'uncertain task');
});

test('offline waits for online and locking prevents subsequent reconnect events',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  page.windowEvents.offline();assert.equal(socket.readyState,3);
  assert(page.elements.get('connection-status').textContent.includes('网络已断开'));
  assert(!page.timers.some(timer=>timer.delay===2000&&!timer.cancelled));
  page.windowEvents.online();assert.equal(page.sockets.length,2);
  page.elements.get('btn-lock').listeners.click();
  page.windowEvents.online();page.windowEvents.pageshow();assert.equal(page.sockets.length,2);
});

test('a connecting socket suspended in the background still has a deadline on return',async()=>{
  const page=await browser();
  page.document.visibilityState='hidden';page.documentEvents.visibilitychange();
  page.document.visibilityState='visible';page.documentEvents.visibilitychange();
  fireTimer(page,10000);assert.equal(page.sockets[0].readyState,3);
  fireTimer(page,2000);assert.equal(page.sockets.length,2);
});
const gitFiles=[{file:'a.ts',code:'M'},{file:'b.ts',code:'M'}];
async function diffPage(){
  const requests=[];
  const page=await browser({fetchImpl:(url,options={})=>{
    if(url.includes('/auth/'))return Promise.resolve({ok:true,status:200,json:async()=>({ok:true,cwd:'/synthetic'})});
    return new Promise((resolve,reject)=>requests.push({url,options,done:false,
      respond(data,status=200){this.done=true;resolve({ok:status>=200&&status<300,status,json:async()=>data});},
      reject(error){this.done=true;reject(error);}}));
  }});
  function statuses(files=gitFiles){for(const request of requests.filter(r=>!r.done&&r.url==='/api/git/status'))request.respond({ok:true,branch:'main',files});}
  statuses();await flush();
  page.tabs.get('diff').listeners.click();statuses();await flush();
  const pending=file=>requests.filter(r=>!r.done&&r.url===`/api/git/diff${file?'?file='+encodeURIComponent(file):''}`).at(-1);
  const choose=file=>page.elements.get('file-chips').children.find(chip=>chip.textContent.endsWith(file)).listeners.click();
  return {...page,requests,statuses,pending,choose,poll(){page.intervals[0].fn();}};
}

test('late Git responses and failures cannot overwrite a newer file selection',async()=>{
  const page=await diffPage();const all=page.pending('');
  page.choose('a.ts');const a=page.pending('a.ts');
  page.choose('b.ts');const b=page.pending('b.ts');
  b.respond({ok:true,hasChanges:true,html:'B preview'});await flush();
  a.respond({ok:true,hasChanges:true,html:'A preview'});await flush();
  assert.equal(page.elements.get('diff-container').innerHTML,'B preview');
  all.reject(Error('late failure'));await flush();
  assert.equal(page.elements.get('diff-container').innerHTML,'B preview');
  assert(a.options.signal.aborted);assert(all.options.signal.aborted);
});

test('unchanged Git polling retains DOM nodes, focus targets and both scroll axes',async()=>{
  const page=await diffPage(),diff=page.elements.get('diff-container'),chips=page.elements.get('file-chips');
  page.pending('').respond({ok:true,hasChanges:true,html:'same preview'});await flush();
  diff.scrollTop=240;diff.scrollLeft=19;chips.scrollLeft=32;
  const writes=diff.htmlWrites,firstChip=chips.children[0];
  page.poll();page.statuses();await flush();
  page.pending('').respond({ok:true,hasChanges:true,html:'same preview'});await flush();
  assert.equal(diff.htmlWrites,writes);assert.equal(diff.scrollTop,240);assert.equal(diff.scrollLeft,19);
  assert.equal(chips.children[0],firstChip);assert.equal(chips.scrollLeft,32);
});

test('updated previews keep current-file scrolling and reset scrolling for a different file',async()=>{
  const page=await diffPage(),diff=page.elements.get('diff-container');
  page.pending('').respond({ok:true,hasChanges:true,html:'initial preview'});await flush();
  diff.scrollTop=140;diff.scrollLeft=12;
  page.poll();page.statuses();await flush();
  page.pending('').respond({ok:true,hasChanges:true,html:'updated preview'});await flush();
  assert.equal(diff.innerHTML,'updated preview');assert.equal(diff.scrollTop,140);assert.equal(diff.scrollLeft,12);
  page.choose('a.ts');assert.equal(diff.scrollTop,0);assert(!diff.innerHTML.includes('updated preview'));
  page.pending('a.ts').respond({ok:true,hasChanges:true,html:'A preview'});await flush();
  assert.equal(diff.scrollTop,0);assert.equal(diff.scrollLeft,0);
});

test('slow Git requests are coalesced instead of piling up at each polling interval',async()=>{
  const page=await diffPage();
  for(let i=0;i<3;i++)page.poll();
  assert.equal(page.requests.filter(r=>!r.done&&r.url==='/api/git/status').length,1);
  page.statuses();await flush();
  assert.equal(page.requests.filter(r=>!r.done&&r.url==='/api/git/diff').length,1);
});

test('horizontal positions follow file identities when diff2html rebuilds and reorders file panels',async()=>{
  const page=await diffPage(),diff=page.elements.get('diff-container');
  let wrappers=[];
  diff.querySelectorAll=selector=>selector==='.d2h-file-wrapper'?wrappers:[];
  diff.onHtmlChange=html=>{
    const ids=html==='first order'?['file-a','file-b']:['file-b','file-a'];
    wrappers=ids.map(id=>({id,panels:[{scrollTop:0,scrollLeft:0}],querySelectorAll(){return this.panels;}}));
  };
  page.pending('').respond({ok:true,hasChanges:true,html:'first order'});await flush();
  wrappers[0].panels[0].scrollLeft=180;wrappers[1].panels[0].scrollLeft=70;
  page.poll();page.statuses();await flush();
  page.pending('').respond({ok:true,hasChanges:true,html:'second order'});await flush();
  assert.equal(wrappers.find(wrapper=>wrapper.id==='file-a').panels[0].scrollLeft,180);
  assert.equal(wrappers.find(wrapper=>wrapper.id==='file-b').panels[0].scrollLeft,70);
});

test('leaving Git Diff or locking cancels pending previews and ignores late responses',async()=>{
  const page=await diffPage(),diff=page.elements.get('diff-container'),old=page.pending('');
  page.tabs.get('terminal').listeners.click();const writes=diff.htmlWrites;
  old.respond({ok:true,hasChanges:true,html:'hidden old preview'});await flush();
  assert.equal(diff.htmlWrites,writes);assert(old.options.signal.aborted);
  page.tabs.get('diff').listeners.click();page.statuses();await flush();
  const locked=page.pending('');page.elements.get('btn-lock').listeners.click();
  locked.respond({ok:true,hasChanges:true,html:'private old preview'});await flush();
  assert(!diff.innerHTML.includes('private old preview'));assert(locked.options.signal.aborted);
});

test('an old unauthorized Git response cannot lock a newly authenticated session',async()=>{
  const page=await diffPage(),old=page.pending('');
  page.elements.get('btn-lock').listeners.click();
  page.elements.get('auth-token-input').value='synthetic-new-session-credential';
  await page.elements.get('auth-form').listeners.submit({preventDefault(){}});
  page.statuses();await flush();
  old.respond({ok:false},401);await flush();
  assert.equal(page.storage.get('codex_relay_auth_token'),'synthetic-new-session-credential');
});

test('a removed selected file falls back to all changes without restoring its stale preview',async()=>{
  const page=await diffPage(),diff=page.elements.get('diff-container');
  page.choose('b.ts');const b=page.pending('b.ts');
  page.poll();page.statuses([gitFiles[0]]);await flush();
  page.pending('').respond({ok:true,hasChanges:true,html:'remaining A preview'});await flush();
  b.respond({ok:true,hasChanges:true,html:'removed B preview'});await flush();
  assert.equal(diff.innerHTML,'remaining A preview');assert(b.options.signal.aborted);
});

test('current preview failures and timeouts are visible and manual refresh can recover',async()=>{
  const page=await diffPage(),diff=page.elements.get('diff-container');
  page.pending('').respond({ok:false},500);await flush();
  assert(diff.children[0].textContent.includes('请求失败'));
  page.elements.get('btn-refresh-diff').listeners.click();
  const request=page.pending('');assert(request);
  const deadline=page.timers.find(timer=>timer.delay===12000&&!timer.cancelled);
  deadline.fn();assert(request.options.signal.aborted);
  request.reject(Object.assign(Error('request aborted'),{name:'AbortError'}));await flush();
  assert(diff.children[0].textContent.includes('请求失败'));
  page.elements.get('btn-refresh-diff').listeners.click();
  page.pending('').respond({ok:true,hasChanges:true,html:'recovered preview'});await flush();
  assert.equal(diff.innerHTML,'recovered preview');
});

test('language changes invalidate pending previews and translate unchanged empty states',async()=>{
  const page=await diffPage(),old=page.pending(''),diff=page.elements.get('diff-container');
  const language=page.elements.get('ui-language');language.value='en';language.listeners.change();
  const english=page.pending('');assert.notEqual(english,old);assert(old.options.signal.aborted);
  english.respond({ok:true,hasChanges:false});await flush();
  assert(diff.children[0].textContent.includes('Working tree clean'));
  old.respond({ok:true,hasChanges:true,html:'old locale preview'});await flush();
  assert(!diff.innerHTML.includes('old locale preview'));
  language.value='zh-CN';language.listeners.change();
  page.pending('').respond({ok:true,hasChanges:false});await flush();
  assert(diff.children[0].textContent.includes('工作区干净'));
});

test('language and font preferences restore and change without replacing the terminal or draft',async()=>{
  const page=await browser({preferences:{codex_relay_language:'en',codex_relay_font_size:'17'}}),socket=page.sockets[0];socket.open();
  assert.equal(page.document.documentElement.lang,'en');assert.equal(page.terminal.options.fontSize,17);
  assert.equal(page.elements.get('connection-status').textContent,'Connected');
  const input=page.elements.get('prompt-input');input.value='unsent draft';
  const language=page.elements.get('ui-language');language.value='zh-CN';language.listeners.change();
  assert.equal(page.storage.get('codex_relay_language'),'zh-CN');
  assert.equal(page.elements.get('auth-language').value,'zh-CN');
  assert.equal(page.elements.get('connection-status').textContent,'已连接');
  const font=page.elements.get('font-size');font.value='15';font.listeners.change();
  assert.equal(page.terminal.options.fontSize,15);assert.equal(page.storage.get('codex_relay_font_size'),'15');
  assert.equal(input.value,'unsent draft');assert.equal(page.sockets.length,1);assert.equal(page.terminal.resets,0);
  assert(socket.sent.every(message=>message.type==='resize'));
});

test('unsupported preferences fall back and both languages cover visible interface keys',async()=>{
  const page=await browser({preferences:{codex_relay_language:'xx',codex_relay_font_size:'999'},browserLanguage:'en-US'});
  assert.equal(page.document.documentElement.lang,'en');assert.equal(page.terminal.options.fontSize,13);
  const dictionaries=page.i18n.messages;
  assert.deepEqual(Object.keys(dictionaries.en).sort(),Object.keys(dictionaries['zh-CN']).sort());
  for(const match of fs.readFileSync(path.join(project,'public','index.html'),'utf8').matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)) {
    assert(dictionaries.en[match[1]],`Missing English: ${match[1]}`);
    assert(dictionaries['zh-CN'][match[1]],`Missing Chinese: ${match[1]}`);
  }
});

test('workspace labels use the folder name while preserving the full path as text',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  socket.message({type:'status',running:true,cwd:'C:\\work\\my-project'});
  assert.equal(page.elements.get('cwd-label').textContent,'my-project');
  assert.equal(page.elements.get('workspace-path').textContent,'C:\\work\\my-project');
});

test('restart requires confirmation and cancellation never sends a restart',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  const button=page.elements.get('btn-restart'),dialog=page.elements.get('restart-dialog');
  button.listeners.click();assert(dialog.open);assert.equal(socket.sent.length,0);
  page.elements.get('restart-cancel').listeners.click();assert(!dialog.open);assert.equal(socket.sent.length,0);
  button.listeners.click();page.elements.get('restart-confirm').listeners.click();
  assert.equal(socket.sent.length,1);assert.equal(socket.sent[0].type,'restart');assert(button.disabled);
  button.listeners.click();assert(!dialog.open);
  socket.message({type:'session-reset',cols:80,rows:24});assert(!button.disabled);
  assert(page.elements.get('action-status').textContent.includes('重新创建'));
  button.listeners.click();socket.close();assert(!dialog.open);
  page.elements.get('restart-confirm').listeners.click();assert.equal(socket.sent.filter(message=>message.type==='restart').length,1);
});

test('mobile menu buttons send separate navigation and confirmation actions',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  for(const action of ['up','down','tab','enter']) {
    page.actions.get(action).listeners.click();
    assert.equal(socket.sent.at(-1).type,'action');
    assert.equal(socket.sent.at(-1).action,action);
    socket.message({type:'action-ack',id:socket.sent.at(-1).id});
  }
  assert.equal(socket.sent.length,4);
});

test('shortcut feedback waits for acknowledgement and blocks rapid repeated clicks',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  const button=page.actions.get('enter');button.listeners.click();
  const frame=socket.sent.at(-1);assert(frame.id);
  button.listeners.click();page.actions.get('down').listeners.click();
  assert.equal(socket.sent.length,1);
  assert(button.disabled);assert(page.elements.get('action-status').textContent.includes('正在发送'));
  socket.message({type:'action-ack',id:'stale'});assert(button.disabled);
  socket.message({type:'action-ack',id:frame.id});assert(!button.disabled);
  assert(page.elements.get('action-status').textContent.includes('已写入终端'));
  button.listeners.click();socket.message({type:'action-error',id:socket.sent.at(-1).id});
  assert(page.elements.get('action-status').textContent.includes('操作失败'));assert(!button.disabled);
});

test('shortcut timeouts and disconnects report uncertain delivery without retrying',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  page.actions.get('approve').listeners.click();
  page.timers.find(timer=>timer.delay===7000).fn();
  assert.equal(socket.sent.length,1);assert(page.elements.get('action-status').textContent.includes('是否送达未知'));
  page.actions.get('enter').listeners.click();socket.close();
  assert(page.elements.get('action-status').textContent.includes('是否送达未知'));
  assert(page.elements.get('connection-status').textContent.includes('重连'));
  assert(page.actions.get('enter').disabled);
  page.actions.get('enter').listeners.click();assert.equal(socket.sent.length,2);
  assert(page.elements.get('action-status').textContent.includes('未发送'));
});

test('ended terminals disable keys but allow an acknowledged explicit start',async()=>{
  const page=await browser(),socket=page.sockets[0];socket.open();
  socket.message({type:'status',running:false});
  assert(page.actions.get('enter').disabled);assert(!page.actions.get('start_codex').disabled);
  page.actions.get('enter').listeners.click();assert.equal(socket.sent.length,0);
  page.actions.get('start_codex').listeners.click();const frame=socket.sent.at(-1);
  socket.message({type:'session-reset',cols:80,rows:24});
  socket.message({type:'status',running:true});
  socket.message({type:'action-ack',id:frame.id});
  assert(!page.actions.get('enter').disabled);
  assert(page.elements.get('action-status').textContent.includes('已写入终端'));
});

test('Send preserves disconnected drafts and clears only an acknowledged unchanged draft',async()=>{
  const page=await browser(),input=page.elements.get('prompt-input');
  input.value='keep this draft';page.submit();assert.equal(input.value,'keep this draft');
  const socket=page.sockets[0];socket.open();page.submit();
  assert.equal(input.value,'keep this draft');
  const first=socket.sent.find(message=>message.type==='input');assert(first.id);
  page.submit();assert.equal(socket.sent.filter(message=>message.type==='input').length,1);
  socket.message({type:'input-ack',id:first.id});assert.equal(input.value,'');
  input.value='second';page.submit();const second=socket.sent.at(-1);
  input.value='newer unsent text';socket.message({type:'input-ack',id:second.id});
  assert.equal(input.value,'newer unsent text');
});

test('shared screen resizing waits for pending output instead of changing local geometry',async()=>{
  const page=await browser({delayedWrites:true}),socket=page.sockets[0];socket.open();
  page.timers.find(timer=>timer.delay===80).fn();
  assert.equal(socket.sent.at(-1).type,'resize');assert.equal(socket.sent.at(-1).cols,120);
  assert.equal(page.terminal.cols,80,'measuring the viewport must not resize the local grid');
  socket.message({type:'output',data:'old-size text'});
  socket.message({type:'history',cols:40,rows:12,data:'shared snapshot'});
  socket.message({type:'output',data:' new output'});
  assert.equal(page.terminal.cols,80);
  page.writes.shift()();assert.equal(page.terminal.cols,40);assert.equal(page.terminal.rows,12);
  page.writes.shift()();page.writes.shift()();
  assert.equal(page.terminal.output,'shared snapshot new output');
});

test('a closed terminal retains drafts and restart invalidates the pending input ID',async()=>{
  const page=await browser(),socket=page.sockets[0],input=page.elements.get('prompt-input');socket.open();
  socket.message({type:'status',running:false,kind:'unknown'});input.value='saved draft';page.submit();
  assert.equal(socket.sent.length,0);assert.equal(input.value,'saved draft');
  assert(page.elements.get('terminal-state').textContent.includes('未提供退出状态'));
  socket.message({type:'status',running:true});page.submit();const oldId=socket.sent.at(-1).id;
  socket.message({type:'session-reset',cols:40,rows:12});socket.message({type:'input-ack',id:oldId});
  assert.equal(input.value,'saved draft');page.submit();assert.notEqual(socket.sent.at(-1).id,oldId);
});

test('uncertain delivery retries with the same ID and reconnect history replaces the display',async()=>{
  const page=await browser(),input=page.elements.get('prompt-input'),socket=page.sockets[0];
  socket.open();input.value='uncertain';page.submit();const first=socket.sent.at(-1);
  page.timers.find(timer=>timer.delay===7000).fn();page.submit();
  assert.equal(socket.sent.at(-1).id,first.id);assert.equal(input.value,'uncertain');
  socket.message({type:'history',data:'previous output'});socket.message({type:'output',data:' live'});
  socket.message({type:'history',data:'previous output live'});
  assert.equal(page.terminal.output,'previous output live');assert.equal(page.terminal.resets,2);
  socket.close();page.timers.find(timer=>timer.delay===2000).fn();
  const replacement=page.sockets[1];replacement.open();
  socket.message({type:'output',data:'stale'});assert(!page.terminal.output.includes('stale'));
  page.submit();assert.equal(replacement.sent.at(-1).id,first.id);
});
