const {defineConfig,devices}=require('@playwright/test');
const port=Number(process.env.RELAY_E2E_PORT||43187);
module.exports=defineConfig({
  testDir:'./tests/browser',
  testMatch:'**/*.spec.cjs',
  fullyParallel:false,
  workers:1,
  retries:process.env.CI?1:0,
  forbidOnly:!!process.env.CI,
  timeout:60000,
  expect:{timeout:10000},
  reporter:process.env.CI?[['line'],['html',{open:'never'}]]:[['list']],
  use:{baseURL:`http://127.0.0.1:${port}`,locale:'en-US',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[
    {name:'desktop-chromium',use:{...devices['Desktop Chrome']}},
    {name:'mobile-chromium',use:{...devices['Pixel 7']}},
    {name:'mobile-webkit',use:{...devices['iPhone 13']}},
  ],
  webServer:{command:'node tests/browser/server.cjs',url:`http://127.0.0.1:${port}/__test/ready`,reuseExistingServer:false,timeout:20000},
});
