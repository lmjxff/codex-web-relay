const {test,expect}=require('@playwright/test');
const token='browser-test-access-credential-000000';
const controlHeaders={'x-fixture-key':'browser-fixture-control-only'};
async function control(request,name){return (await request.post(`/__test/${name}`,{headers:controlHeaders})).json();}
async function stats(request){return (await request.get('/__test/stats',{headers:controlHeaders})).json();}
async function connected(page){await expect(page.locator('#connection-status')).toHaveText('Connected');await expect(page.locator('[data-action="enter"]')).toBeEnabled();}
async function login(page){
  await page.goto('/');
  await page.getByPlaceholder('Enter access credential').fill(token);
  await page.getByRole('button',{name:'Unlock terminal →',exact:true}).click();
  await connected(page);
}
function screen(page){return page.locator('.xterm-rows');}
const pageErrors=new WeakMap();
test.beforeEach(async({page,request})=>{
  const errors=[];pageErrors.set(page,errors);page.on('pageerror',error=>errors.push(error.message));
  await control(request,'reset');
});
test.afterEach(async({page})=>{expect(pageErrors.get(page)).toEqual([]);});

test('login, saved authentication, magic-link cleanup and locking',{tag:'@auth'},async({page})=>{
  const external=[];
  page.on('request',request=>{if(!new URL(request.url()).hostname.match(/^(127\.0\.0\.1|localhost)$/))external.push(request.url());});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Codex Web Relay lock'})).toBeVisible();
  await page.getByPlaceholder('Enter access credential').fill('invalid-example');
  await page.getByRole('button',{name:'Unlock terminal →',exact:true}).click();
  await expect(page.locator('#auth-error')).toContainText('Credential verification failed.');
  await page.getByPlaceholder('Enter access credential').fill(token);
  await page.getByRole('button',{name:'Unlock terminal →',exact:true}).click();
  await connected(page);await page.reload();await connected(page);
  await page.getByRole('button',{name:'Lock and sign out of this browser'}).click();
  await expect(page.locator('#auth-overlay')).toBeVisible();
  await page.reload();await expect(page.locator('#auth-overlay')).toBeVisible();
  await page.goto(`/?token=${token}`);await connected(page);
  await expect(page).not.toHaveURL(/token=/);
  expect(external).toEqual([]);
});

test('language and font settings persist and keep the unsent draft',async({page})=>{
  await login(page);
  await page.locator('#prompt-input').fill('keep this draft');
  await page.locator('#ui-language').selectOption('zh-CN');
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await page.getByRole('combobox',{name:'终端字号'}).selectOption('17');
  await expect(page.locator('#prompt-input')).toHaveValue('keep this draft');
  await expect(page.locator('.xterm-rows')).toHaveCSS('font-size','17px');
  await page.reload();
  await expect(page.locator('#connection-status')).toHaveText('已连接');
  await expect(page.locator('#ui-language')).toHaveValue('zh-CN');
  await expect(page.locator('#font-size')).toHaveValue('17');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
});

test('phone menu navigation redraws one shared screen on both browsers',async({page,context,request})=>{
  await login(page);
  const other=await context.newPage();await other.setViewportSize({width:390,height:844});
  await other.goto('/');await connected(other);
  await expect(screen(page)).toContainText('1. Yes, proceed');
  await other.getByRole('button',{name:'↓ Down',exact:true}).click();
  await expect(other.locator('#action-status')).toContainText('Key written');
  await expect(screen(page)).toContainText('> 2. No, cancel');
  await other.getByRole('button',{name:'↑ Up',exact:true}).click();
  await expect(other.locator('[data-action="enter"]')).toBeEnabled();
  await other.getByRole('button',{name:'Enter ↵',exact:true}).click();
  for(const tab of [page,other]){
    await expect(screen(tab)).toContainText('Working: approved');
    await expect(screen(tab)).not.toContainText('Yes, proceed');
  }
  expect((await stats(request)).writes).toEqual(['\x1b[B','\x1b[A',process.platform==='win32'?'\r':'\n']);
});

test('restart cancellation preserves the session and explicit confirmation resets both views',async({page,context,request})=>{
  await login(page);const other=await context.newPage();await other.goto('/');await connected(other);
  const before=await stats(request);
  await page.getByRole('button',{name:'↻ Restart',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  expect((await stats(request)).spawns).toBe(before.spawns);
  await page.getByRole('button',{name:'↻ Restart',exact:true}).click();
  await page.getByRole('button',{name:'Restart session',exact:true}).click();
  await expect.poll(async()=> (await stats(request)).spawns).toBe(before.spawns+1);
  for(const tab of [page,other])await expect(screen(tab)).toContainText(`Session ${before.spawns+1}`);
});

test('offline recovery preserves drafts and restores progress without replaying input',async({page,context,request})=>{
  await login(page);
  await page.locator('#prompt-input').fill('do not replay me');
  const before=await stats(request);
  await context.setOffline(true);
  await expect(page.locator('#connection-status')).not.toHaveText('Connected');
  await page.getByRole('button',{name:'Send ↵',exact:true}).click();
  await expect(page.locator('#prompt-input')).toHaveValue('do not replay me');
  await control(request,'disconnect');await control(request,'progress');
  await context.setOffline(false);await connected(page);
  await expect(screen(page)).toContainText('Recovered while offline');
  await expect(page.locator('#prompt-input')).toHaveValue('do not replay me');
  expect(await stats(request)).toEqual(before);
  await page.getByRole('button',{name:'Send ↵',exact:true}).click();
  await expect(page.locator('#prompt-input')).toHaveValue('');
  await expect(screen(page)).toContainText('Received: do not replay me');
  expect((await stats(request)).writes).toHaveLength(1);
});

test('Git preview switches files, retains wide-line scrolling and recovers after a request failure',async({page})=>{
  await login(page);
  await page.getByRole('tab',{name:/Git Diff/}).click();
  await page.getByRole('button',{name:'M alpha.txt',exact:true}).click();
  await expect(page.locator('#diff-container')).toContainText('alpha-0');
  const scroller=page.locator('.d2h-file-diff').first();
  await scroller.evaluate(element=>{element.scrollLeft=160;});
  await expect.poll(()=>scroller.evaluate(element=>element.scrollLeft)).toBeGreaterThan(100);
  await page.getByRole('button',{name:'⟳ Refresh',exact:true}).click();
  await expect.poll(()=>scroller.evaluate(element=>element.scrollLeft)).toBeGreaterThan(100);
  await page.getByRole('button',{name:'M beta.txt',exact:true}).click();
  await expect(page.locator('#diff-container')).toContainText('beta-only-change');
  await expect(page.locator('#diff-container')).not.toContainText('alpha-0');
  await page.route('**/api/git/diff*',route=>route.abort());
  await page.getByRole('button',{name:'⟳ Refresh',exact:true}).click();
  await expect(page.locator('#diff-container')).toContainText('Failed to fetch diff preview.');
  await page.unroute('**/api/git/diff*');
  await page.getByRole('button',{name:'⟳ Refresh',exact:true}).click();
  await expect(page.locator('#diff-container')).toContainText('beta-only-change');
});

test('reconnecting an ended terminal keeps it ended until an explicit restart',async({page,request})=>{
  await login(page);const before=await stats(request);
  await control(request,'end');
  await expect(page.locator('#terminal-state')).toContainText('ended normally');
  await expect(page.locator('[data-action="enter"]')).toBeDisabled();
  await control(request,'disconnect');await expect(page.locator('#connection-status')).not.toHaveText('Connected');
  await expect(page.locator('#connection-status')).toHaveText('Connected');
  await expect(page.locator('[data-action="enter"]')).toBeDisabled();
  expect(await stats(request)).toEqual(before);
});

test('a slow previous Git file cannot replace the newly selected preview',async({page})=>{
  await login(page);await page.getByRole('tab',{name:/Git Diff/}).click();
  let release,received;
  const pending=new Promise(resolve=>{release=resolve;});
  const intercepted=new Promise(resolve=>{received=resolve;});
  await page.route('**/api/git/diff?file=alpha.txt',async route=>{
    const response=await route.fetch();received();await pending;
    await route.fulfill({response}).catch(()=>{}); // Switching files aborts this request.
  });
  try {
    await page.getByRole('button',{name:'M alpha.txt',exact:true}).click();await intercepted;
    await page.getByRole('button',{name:'M beta.txt',exact:true}).click();
    await expect(page.locator('#diff-container')).toContainText('beta-only-change');
  } finally {release();await page.unrouteAll({behavior:'wait'});}
  await expect(page.locator('#diff-container')).not.toContainText('alpha-0');
  await expect(page.locator('.file-chip.active')).toHaveText('M beta.txt');
});
