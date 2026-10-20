/*
 * wb-token-refresh.cjs —— WorkBuddy 令牌保活脚本
 * ===============================================================
 * 用途：给 workbuddy-cli.cjs 桥接层提供「永远新鲜」的 accessToken。
 *
 * 背景：新版桌面版把凭据文件（workbuddy-desktop.info）里的令牌做了
 *       AES-GCM 加密，解密密钥只发给它自己的子进程。从外部启动的 CLI
 *       读不到，于是桥接报 Authentication required。
 *       绕法是把明文令牌交给 CLI（CODEBUDDY_AUTH_TOKEN 环境变量），
 *       本脚本负责在令牌快过期时用 refreshToken 换新的。
 *
 * 凭据文件：%USERPROFILE%\.claudian\wb-token.json
 *   { accessToken, refreshToken, expiresIn, scope, domain }
 *
 * 用法：
 *   node wb-token-refresh.cjs             # 快过期才刷新（< 阈值），否则秒退
 *   node wb-token-refresh.cjs --force     # 强制刷新
 *   node wb-token-refresh.cjs --print     # 打印当前 accessToken（不刷新）
 *   node wb-token-refresh.cjs --status    # 打印剩余有效期
 *
 * 退出码：0 成功；1 失败（令牌缺失/刷新被拒）。
 * 刷新失败不影响桥接层：令牌没坏就继续用，坏了才需要重新登录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const TOKEN_FILE = path.join(os.homedir(), '.claudian', 'wb-token.json');
const LOG_FILE = path.join(os.homedir(), '.claudian', 'token-refresh.log');

// 提前多久刷新（秒）。默认 1 小时，避免边界上刚好过期。
const REFRESH_THRESHOLD_SEC = Number(
  process.env.WORKBUDDY_TOKEN_REFRESH_THRESHOLD || 3600
);

const REFRESH_HOST = 'www.workbuddy.cn';
const REFRESH_PATH = '/v2/plugin/auth/token/refresh';

const args = process.argv.slice(2);

function log(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) {
      fs.writeFileSync(LOG_FILE, '');
    }
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_e) {
    /* 日志失败不影响主流程 */
  }
}

function readToken() {
  try {
    const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (!d || !d.accessToken) return null;
    return d;
  } catch (_e) {
    return null;
  }
}

function writeToken(d) {
  // 0600：仅本人可读
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(d, null, 1), { mode: 0o600 });
}

// 解析 JWT 的 exp（秒）。解析失败返回 null。
function jwtExpSec(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length < 2) return null;
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch (_e) {
    return null;
  }
}

function secondsLeft(token) {
  const exp = jwtExpSec(token);
  if (exp == null) return null;
  return exp - Math.floor(Date.now() / 1000);
}

// 用 https 模块发刷新请求：显式禁用连接池，进程能立刻干净退出
// （用全局 fetch 时 undici 的 keep-alive socket 会在退出时触发 libuv 断言）
function requestRefresh(cur) {
  return new Promise((resolve, reject) => {
    const body = '{}';
    const req = https.request(
      {
        hostname: REFRESH_HOST,
        port: 443,
        path: REFRESH_PATH,
        method: 'POST',
        agent: false,
        headers: {
          'X-Refresh-Token': cur.refreshToken,
          'X-Auth-Refresh-Source': 'plugin',
          'X-No-Authorization': 'true',
          'X-No-User-Id': 'true',
          'X-No-Enterprise-Id': 'true',
          'X-No-Department-Info': 'true',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(buf);
          } catch (_e) {
            return reject(new Error('刷新响应不是 JSON: ' + buf.slice(0, 200)));
          }
          if (json.code !== 0 || !json.data || !json.data.accessToken) {
            return reject(new Error('刷新被拒: ' + JSON.stringify(json).slice(0, 300)));
          }
          resolve(json.data);
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('刷新请求超时')));
    req.end(body);
  });
}

async function doRefresh(cur) {
  const d = await requestRefresh(cur);
  const next = {
    accessToken: d.accessToken,
    refreshToken: d.refreshToken || cur.refreshToken, // 未下发新 RT 则沿用
    expiresIn: d.expiresIn,
    refreshExpiresIn: d.refreshExpiresIn,
    scope: d.scope || cur.scope,
    domain: d.domain || cur.domain,
    savedAt: new Date().toISOString(),
  };
  writeToken(next);
  return next;
}

(async () => {
  const cur = readToken();

  if (args.includes('--print')) {
    if (!cur) {
      console.error('NO_TOKEN');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(cur.accessToken);
    return;
  }

  if (args.includes('--status')) {
    if (!cur) {
      console.log('NO_TOKEN：请先跑一次登录抓取');
      process.exitCode = 1;
      return;
    }
    const left = secondsLeft(cur.accessToken);
    console.log(
      `accessToken 剩余约 ${left == null ? '未知' : Math.floor(left / 86400) + ' 天 ' + Math.floor((left % 86400) / 3600) + ' 小时'}`
    );
    const rleft = secondsLeft(cur.refreshToken);
    console.log(
      `refreshToken 剩余约 ${rleft == null ? '未知' : Math.floor(rleft / 86400) + ' 天'}`
    );
    return;
  }

  if (!cur) {
    log('无令牌文件，跳过（需重新登录）');
    process.exitCode = 1;
    return;
  }

  const left = secondsLeft(cur.accessToken);
  const force = args.includes('--force');
  if (!force && left != null && left > REFRESH_THRESHOLD_SEC) {
    log(`令牌仍有效（剩余 ${left}s），无需刷新`);
    return;
  }

  try {
    const next = await doRefresh(cur);
    log(`刷新成功，新令牌剩余 ${secondsLeft(next.accessToken)}s`);
  } catch (err) {
    log('刷新失败: ' + (err && err.message ? err.message : String(err)));
    // 旧令牌还没过期就还能用，退出码仍为 0，避免桥接层误判
    if (!(left != null && left > 0)) process.exitCode = 1;
  }
})();
