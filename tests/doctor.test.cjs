const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const net=require('node:net');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const {fixture,cleanup,project}=require('./helpers.cjs');
const {diagnose,commandExists}=require('../dist/doctor.js');
const healthy={command:()=>true,git:async()=>true,pty:()=>true,port:async()=>true,tunnelBinary:()=>true,certificate:()=>true};
const status=(checks,id)=>checks.find(check=>check.id===id)?.status;

test('doctor respects environment overrides and produces a redacted report without changing .env',async()=>{
  const directory=fixture();
  try {
    const content='RELAY_AUTH_TOKEN=private-doctor-token-example-long\nCF_HOSTNAME=private.example.test\nENABLE_TUNNEL=true\nPORT=0\n';
    fs.writeFileSync(path.join(directory,'.env'),content);
    const checks=await diagnose({cwd:directory,env:{PORT:'43210'},probes:healthy});
    assert(!checks.some(check=>check.status==='error'));
    for(const privateValue of ['private-doctor-token-example-long','private.example.test',directory])assert(!JSON.stringify(checks).includes(privateValue));
    assert.equal(fs.readFileSync(path.join(directory,'.env'),'utf8'),content);
    assert.deepEqual(fs.readdirSync(directory),['.env']);
    const {stdout}=await promisify(execFile)(process.execPath,[path.join(project,'dist/cli.js'),'--doctor','--json','--lang=zh-CN'],{
      cwd:directory,env:{...process.env,ENABLE_TUNNEL:'false',PORT:'0',CODEX_CMD:'missing-doctor-example',CODEX_CWD:directory},windowsHide:true,
    }).catch(error=>{assert.equal(error.code,1);return {stdout:error.stdout};});
    const report=JSON.parse(stdout);
    assert.equal(report.ok,false);assert(report.checks.some(check=>check.id==='port'&&check.status==='error'));
    assert(!stdout.includes('private-doctor-token-example-long'));assert(!stdout.includes(directory));
    assert.deepEqual(fs.readdirSync(directory),['.env'],'diagnostics must not create config, logs or workspaces');
  } finally { cleanup(directory); }
});

test('doctor differentiates missing prerequisites, optional Codex, invalid settings and Git-only warnings',async()=>{
  const directory=fixture();
  try {
    const checks=await diagnose({cwd:directory,nodeVersion:'20.19.0',env:{PORT:'bad',ENABLE_TUNNEL:'true',RELAY_AUTH_TOKEN:'short',CF_TUNNEL_TOKEN:'synthetic'},
      probes:{...healthy,command:()=>false,pty:()=>false,tunnelBinary:()=>false}});
    for(const id of ['node','git','codex','pty','port','credential','tunnel'])assert.equal(status(checks,id),'error',id);
    assert.equal(status(checks,'cloudflared'),'warn');
    const optional=await diagnose({cwd:directory,env:{AUTO_START_CODEX:'false',CODEX_CWD:'does-not-exist'},probes:{...healthy,command:command=>command==='git'}});
    assert.equal(status(optional,'codex'),'warn');assert.equal(status(optional,'workspace'),'error');
    const noGitWorktree=await diagnose({cwd:directory,env:{},probes:{...healthy,git:async()=>false}});
    assert.equal(status(noGitWorktree,'git-workspace'),'warn');assert.equal(status(noGitWorktree,'credential'),'warn');
    assert.equal(status(noGitWorktree,'tunnel'),'ok');
  } finally { cleanup(directory); }
});

test('doctor distinguishes tunnel modes without installing or contacting Cloudflare',async()=>{
  const directory=fixture();
  try {
    let binaryChecks=0;
    const check=env=>diagnose({cwd:directory,env:{ENABLE_TUNNEL:'true',...env},probes:{...healthy,certificate:()=>false,tunnelBinary:()=>{binaryChecks++;return false;}}});
    assert.equal(status(await check({}),'tunnel'),'ok','temporary tunnel requires no account');
    assert.equal(status(await check({CF_HOSTNAME:'example.test'}),'tunnel'),'error','certificate mode needs login');
    assert.equal(status(await check({CF_HOSTNAME:'example.test',CF_TUNNEL_TOKEN:'synthetic'}),'tunnel'),'ok');
    assert.equal(status(await check({CF_HOSTNAME:'https://example.test/path'}),'tunnel'),'error');
    assert.equal(binaryChecks,4);
  } finally { cleanup(directory); }
});

test('doctor detects an occupied local port and closes its temporary port probe',async()=>{
  const directory=fixture();
  const listener=net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  try {
    const options={cwd:directory,env:{HOST:'127.0.0.1',PORT:String(port)},probes:{...healthy,port:undefined}};
    delete options.probes.port;
    assert.equal(status(await diagnose(options),'port'),'error');
    await new Promise(resolve=>listener.close(resolve));
    assert.equal(status(await diagnose(options),'port'),'ok');
    await new Promise(resolve=>listener.listen(port,'127.0.0.1',resolve));
  } finally { await new Promise(resolve=>listener.close(resolve));cleanup(directory); }
});

test('command discovery handles quoted executable paths without executing command arguments',()=>{
  const directory=fixture();
  try {
    const filename=path.join(directory,'sample tool'+(process.platform==='win32'?'.cmd':''));
    fs.writeFileSync(filename,'not an executable program');fs.chmodSync(filename,0o755);
    assert(commandExists(`"${filename}" --private-value && never-run`,{}));
    assert(!commandExists('missing-doctor-executable --anything', {PATH:directory}));
    assert(!commandExists('; invalid',{}));
  } finally { cleanup(directory); }
});
