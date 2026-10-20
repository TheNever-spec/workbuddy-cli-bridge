/*
 * wb-login.cjs —— WorkBuddy 桥接「一键登录」工具
 * ===============================================================
 * 什么时候用：桥接报 Authentication required 且令牌无法自动续期时
 *            （accessToken 有效期约 28 天，refreshToken 约 30 天）。
 *            正常情况下 wb-token-refresh.cjs 会自动续期，不用跑这个。
 *
 * 做什么：
 *   1. 起一个本地的 WorkBuddy CLI 服务（带令牌抓取层）
 *   2. 向它要一个浏览器授权链接并打印出来
 *   3. 你在浏览器里点授权（电脑/手机都行）
 *   4. 抓到明文令牌后自动写入 wb-token.json，关掉服务，退出
 *
 * 用法：
 *   node wb-login.cjs
 *
 * 可选参数：
 *   --port 8878     指定本地端口（默认随机挑一个空闲口）
 *   --timeout 600   等待授权的秒数（默认 600）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DIR = path.join(os.homedir(), '.claudian');
const TOKEN_FILE = path.join(DIR, 'wb-token.json');
const CONFIG_DIR = path.join(DIR, 'wb-cli-config');

const CLI_CANDIDATES = [
  'E:\\WorkBuddy\\resources\\app.asar.unpacked\\cli',
  'C:\\Program Files\\WorkBuddy\\resources\\app.asar.unpacked\\cli',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'WorkBuddy', 'resources', 'app.asar.unpacked', 'cli'),
];

function findEntry() {
  for (const dir of CLI_CANDIDATES) {
    const p = path.join(dir, 'bin', 'codebuddy');
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (_e) {
      /* 忽略 */
    }
  }
  return null;
}

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

// ---------------------------------------------------------------------------
// 子进程角色：装抓取层 → 加载 CLI（CLI 会因 --serve 起本地服务）
// ---------------------------------------------------------------------------
function runChild() {
  // 抹掉本脚本自己的 --child，否则 CLI 会因 unknown option 报错退出
  const filtered = process.argv.slice(2).filter((a) => a !== '--child');
  require(path.join(DIR, 'wb-capture-hook.cjs'));
  const entry = findEntry();
  if (!entry) {
    process.stderr.write('[wb-login] 找不到 WorkBuddy CLI 入口\n');
    process.exit(2);
  }
  process.argv = [process.argv[0], entry, ...filtered];
  require(entry);
}

// ---------------------------------------------------------------------------
// 父进程角色：编排登录流程
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function httpJson(port, method, urlPath, headers, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: Object.assign(
          { 'x-codebuddy-request': '1' },
          payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
          headers || {}
        ),
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, text: buf }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end(payload || undefined);
  });
}

async function waitForServer(port, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      await httpJson(port, 'GET', '/api/v1/auth/account/status', {});
      return true;
    } catch (_e) {
      await sleep(800);
    }
  }
  return false;
}

async function runParent() {
  const entry = findEntry();
  if (!entry) {
    console.error('找不到 WorkBuddy CLI 入口，请检查 CLI_CANDIDATES');
    process.exit(2);
  }

  const port = Number(argVal('--port', 0)) || (await freePort());
  const timeoutSec = Number(argVal('--timeout', 600));

  const mtimeBefore = (() => {
    try {
      return fs.statSync(TOKEN_FILE).mtimeMs;
    } catch (_e) {
      return 0;
    }
  })();

  console.log('正在启动本地登录服务……');
  const child = spawn(
    process.execPath,
    [__filename, '--child', '--serve', '--port', String(port), '--auth', 'password', '--host', '127.0.0.1'],
    {
      env: Object.assign({}, process.env, {
        CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1',
        CODEBUDDY_CONFIG_DIR: CONFIG_DIR,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  let outBuf = '';
  let password = null;
  const onData = (chunk) => {
    outBuf += chunk.toString('utf8');
    const m = outBuf.match(/Password\s+([A-Za-z0-9_\-]+)/);
    if (m) password = m[1];
    if (/wb-login\] 令牌已保存/.test(outBuf)) {
      // 抓取层在子进程里已经写好令牌
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  if (!(await waitForServer(port, 30000))) {
    console.error('本地服务起不来，已退出。日志：\n' + outBuf.slice(-1500));
    try { child.kill(); } catch (_e) {}
    process.exit(3);
  }

  // 等密码出现
  for (let i = 0; i < 40 && !password; i++) await sleep(250);
  if (!password) {
    console.error('没拿到服务密码，已退出。日志：\n' + outBuf.slice(-1500));
    try { child.kill(); } catch (_e) {}
    process.exit(3);
  }

  const headers = { 'x-access-token': password };
  const res = await httpJson(port, 'POST', '/api/v1/auth/account/login', headers, { method: 'internal' });
  let authUrl = null;
  try {
    const j = JSON.parse(res.text);
    authUrl = (j.data && (j.data.url || j.data.authUrl || j.data.loginUrl)) || j.url || null;
  } catch (_e) {
    /* 下面统一报错 */
  }
  if (!authUrl) {
    console.error('没拿到授权链接，原始响应：\n' + res.text.slice(0, 800));
    try { child.kill(); } catch (_e) {}
    process.exit(4);
  }

  console.log('\n========================================');
  console.log('请用浏览器打开下面的链接完成授权（电脑或手机都行）：');
  console.log('\n  ' + authUrl + '\n');
  console.log(`等待授权中……（最多 ${timeoutSec} 秒，授权完成后本脚本自动结束）`);
  console.log('========================================\n');

  const deadline = Date.now() + timeoutSec * 1000;
  let ok = false;
  while (Date.now() < deadline) {
    await sleep(2000);
    try {
      const st = fs.statSync(TOKEN_FILE);
      if (st.mtimeMs > mtimeBefore) {
        const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
        if (d && d.accessToken) {
          ok = true;
          break;
        }
      }
    } catch (_e) {
      /* 还没写 */
    }
    if (child.exitCode !== null) break;
  }

  try { child.kill(); } catch (_e) {}
  await sleep(500);

  if (ok) {
    console.log('授权成功，令牌已保存到 ' + TOKEN_FILE);
    console.log('桥接现在可以直接用了。');
    process.exit(0);
  }
  console.error('等待超时或未拿到令牌。可以重跑一次本脚本。');
  process.exit(5);
}

function freePort() {
  return new Promise((resolve) => {
    const srv = require('net').createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

if (args.includes('--child')) {
  runChild();
} else {
  runParent().catch((e) => {
    console.error('出错：' + (e && e.message ? e.message : String(e)));
    process.exit(1);
  });
}

// 保留 crypto 引用（未来做状态校验用），避免 lint 报未使用
void crypto;
