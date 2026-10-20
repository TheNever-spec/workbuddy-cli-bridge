/*
 * 对照实验 v2：定位「用户消息发出后 CLI 无输出」的触发条件
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const BRIDGE = process.env.WB_BRIDGE || path.join(os.homedir(), '.claudian', 'workbuddy-cli.cjs');
const CWD = process.env.WB_CWD || path.join(os.homedir(), 'Documents', 'Obsidian Vault');

function baseArgs(drop) {
  let a = [
    '--output-format', 'stream-json',
    '--verbose',
    '--input-format', 'stream-json',
    '--model', 'deepseek-v4.1-flash',
    '--permission-prompt-tool', 'stdio',
    '--disallowedTools', 'EnterPlanMode,ExitPlanMode,TodoWrite,TaskCreate,TaskGet,TaskList,TaskUpdate',
    '--tools', '',
    '--setting-sources=user,project,local',
    '--permission-mode', 'bypassPermissions',
    '--allow-dangerously-skip-permissions',
    '--include-partial-messages',
    '--replay-user-messages',
  ];
  if (drop === 'replay') a = a.filter((x) => x !== '--replay-user-messages');
  if (drop === 'tools') {
    const i = a.indexOf('--tools');
    a = a.slice(0, i).concat(a.slice(i + 2));
  }
  if (drop === 'permPrompt') {
    const i = a.indexOf('--permission-prompt-tool');
    a = a.slice(0, i).concat(a.slice(i + 2));
  }
  return a;
}

function initRequest(sysMode) {
  return {
    type: 'control_request',
    request_id: 'req_init_1',
    request: {
      subtype: 'initialize',
      hooks: {},
      sdkMcpServers: [],
      jsonSchema: {},
      agents: {},
      permissionMode: 'bypassPermissions',
      appendSystemPrompt: '',
      systemPrompt:
        sysMode === 'string'
          ? 'You are a helpful assistant operating inside Obsidian.'
          : ['You are a helpful assistant operating inside Obsidian.'],
    },
  };
}

function userMessage(userMode) {
  return {
    type: 'user',
    session_id: '',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: userMode === 'string' ? '只回复两个字：收到' : [{ type: 'text', text: '只回复两个字：收到' }],
    },
  };
}

function runVariant(name, drop, sysMode, userMode, waitMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BRIDGE, ...baseArgs(drop)], {
      cwd: CWD,
      env: { ...process.env, WORKBUDDY_BRIDGE_DEBUG: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const seq = [];
    let sawResult = false;
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let t = 'NOTJSON';
        try {
          const o = JSON.parse(line);
          t = o.type || '?';
          if (o.type === 'result') sawResult = true;
        } catch (_e) {}
        if (t !== 'stream_event') seq.push(t);
      }
    });
    let errTail = '';
    child.stderr.on('data', (d) => {
      errTail = (errTail + String(d)).slice(-400);
    });
    setTimeout(() => child.stdin.write(JSON.stringify(initRequest(sysMode)) + '\n'), 200);
    setTimeout(() => child.stdin.write(JSON.stringify(userMessage(userMode)) + '\n'), waitMs);

    const timer = setTimeout(() => done('超时'), 20000);
    const poll = setInterval(() => {
      if (sawResult) {
        clearInterval(poll);
        clearTimeout(timer);
        done('拿到 result');
      }
    }, 300);
    function done(why) {
      clearInterval(poll);
      clearTimeout(timer);
      try { child.kill(); } catch (_e) {}
      resolve({ name, sawResult, why, seq: seq.join('>'), err: errTail.replace(/\s+/g, ' ').slice(0, 250) });
    }
  });
}

(async () => {
  const cases = [
    ['A 基线：systemPrompt 数组 + user 块数组', '', '', '', 5000],
    ['B systemPrompt 用字符串', '', 'string', '', 5000],
    ['C user.content 用字符串', '', '', 'string', 5000],
    ['D 去掉 --replay-user-messages', 'replay', '', '', 5000],
    ['E 去掉 --tools ""', 'tools', '', '', 5000],
    ['F 去掉 --permission-prompt-tool stdio', 'permPrompt', '', '', 5000],
  ];
  for (const c of cases) {
    const r = await runVariant(...c);
    console.log(`\n#### ${r.name}\n  result=${r.sawResult}  (${r.why})\n  事件=${r.seq}\n  stderr=${r.err || '无'}`);
  }
  process.exit(0);
})();
