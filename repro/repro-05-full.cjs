/*
 * 单次运行 + 完整 stderr 捕获
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const BRIDGE = process.env.WB_BRIDGE || path.join(os.homedir(), '.claudian', 'workbuddy-cli.cjs');
const CWD = process.env.WB_CWD || path.join(os.homedir(), 'Documents', 'Obsidian Vault');
const CLAUDIAN_CFG = path.join(os.homedir(), '.claudian', 'wb-cli-config');

const ARGS = [
  '--output-format', 'stream-json',
  '--verbose',
  '--input-format', 'stream-json',
  '--model', 'deepseek-v4.1-flash',
  '--disallowedTools', 'EnterPlanMode,ExitPlanMode,TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate',
  '--tools', '',
  '--setting-sources=user,project,local',
  '--permission-mode', 'bypassPermissions',
  '--include-partial-messages',
  '--replay-user-messages',
];

const env = {};
for (const [k, v] of Object.entries(process.env)) {
  if (k.startsWith('CODEBUDDY_') || k.startsWith('WORKBUDDY_')) continue;
  env[k] = v;
}
env.CODEBUDDY_CONFIG_DIR = CLAUDIAN_CFG;

const outFile = path.join(__dirname, 'repro-05.out');
const errFile = path.join(__dirname, 'repro-05.err');
const stdoutS = fs.createWriteStream(outFile);
const stderrS = fs.createWriteStream(errFile);

const t0 = Date.now();
const child = spawn(process.execPath, [BRIDGE, ...ARGS], { cwd: CWD, env, stdio: ['pipe', 'pipe', 'pipe'] });
console.log('pid=' + child.pid);
child.stdout.pipe(stdoutS);
child.stderr.pipe(stderrS);
child.stderr.on('data', (d) => process.stdout.write('[ERR ' + (Date.now() - t0) + 'ms] ' + String(d).slice(0, 2000) + '\n'));
child.on('exit', (c, s) => {
  console.log('EXIT code=' + c + ' sig=' + s + ' after ' + (Date.now() - t0) + 'ms');
});

setTimeout(() => child.stdin.write(JSON.stringify({
  type: 'control_request', request_id: 'req_init_1',
  request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [], jsonSchema: {}, agents: {}, permissionMode: 'bypassPermissions', appendSystemPrompt: '', systemPrompt: ['You are helpful.'] },
}) + '\n'), 200);

setTimeout(() => child.stdin.write(JSON.stringify({
  type: 'user', session_id: '', parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'text', text: '只回复两个字：收到' }] },
}) + '\n'), 6000);

setTimeout(() => {
  console.log('60s 到，结束');
  try { child.kill(); } catch (_e) {}
  setTimeout(() => process.exit(0), 500);
}, 60000);
