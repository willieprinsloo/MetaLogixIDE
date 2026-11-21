#!/usr/bin/env node
'use strict';
// Stand-in for a CLI whose node wrapper starts a long-running child (like codex.js starting its
// native binary): writes the child's pid to FAKE_TREE_PID, then waits forever.
const { spawn } = require('child_process');
const fs = require('fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
fs.writeFileSync(process.env.FAKE_TREE_PID, String(child.pid));
process.stdin.resume();
setInterval(() => {}, 1000);
