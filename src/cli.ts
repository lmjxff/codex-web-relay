#!/usr/bin/env node
// Dispatch diagnostics before importing the server or its native dependencies.
if (process.argv.includes('--doctor')) {
  import('./doctor').then(({ runDoctor }) => runDoctor()).catch(() => {
    console.error('[Doctor] Diagnostic failed. Check local file permissions and dependencies.');
    process.exitCode = 1;
  });
} else {
  import('./index').then(({ startRelay }) => startRelay()).catch(() => {
    console.error('[Startup] Cannot load Relay. Check installed dependencies; try --doctor.');
    process.exitCode = 1;
  });
}
