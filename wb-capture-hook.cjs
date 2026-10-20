/*
 * wb-capture-hook.cjs —— 令牌抓取层（登录用）
 * ===============================================================
 * 背景：WorkBuddy 桌面版把凭据文件里的令牌做了 AES-GCM 加密，解密密钥只
 *       发给它自己的子进程，从外部启动的 CLI 读不到（missing-key）。
 *       所以改为在「浏览器授权完成、CLI 换取令牌」的那一瞬间，把明文令牌
 *       从网络层截下来，存成 wb-token.json，之后桥接层用
 *       CODEBUDDY_AUTH_TOKEN 环境变量走。
 *
 * 做法：patch node:http / node:https 的 request 以及 globalThis.fetch，
 *       只对认证相关 URL 的响应做解析；一旦发现 accessToken 就落盘。
 *
 * 落盘：%USERPROFILE%\.claudian\wb-token.json（0600，仅本人可读）
 *
 * 调试：设 WORKBUDDY_LOGIN_DEBUG=1 才把原始请求/响应写
 *       %USERPROFILE%\.claudian\token-capture.log（默认不写，避免明文堆积）。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.claudian');
const TOKEN_FILE = path.join(DIR, 'wb-token.json');
const LOG = path.join(DIR, 'token-capture.log');
const DEBUG = String(process.env.WORKBUDDY_LOGIN_DEBUG || '') === '1';
const FILTER = /(token|auth|login|oauth|sso|device|account|session|oneid|credential)/i;

let saved = false;

function log(msg) {
  if (!DEBUG) return;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 8 * 1024 * 1024) return;
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_e) {
    /* 忽略 */
  }
}

// 从任意响应体里找 accessToken 并落盘。返回 true 表示本次写入成功。
function trySaveToken(bodyText) {
  if (saved || !bodyText || bodyText.indexOf('accessToken') < 0) return false;
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (_e) {
    return false;
  }
  const d = json && json.data;
  if (!d || !d.accessToken) return false;
  const out = {
    accessToken: d.accessToken,
    refreshToken: d.refreshToken,
    expiresIn: d.expiresIn,
    refreshExpiresIn: d.refreshExpiresIn,
    scope: d.scope,
    domain: d.domain,
    savedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(out, null, 1), { mode: 0o600 });
    saved = true;
    // 给外层脚本一个可观测信号
    process.stderr.write('[wb-login] 令牌已保存到 wb-token.json\n');
    return true;
  } catch (e) {
    log('写令牌失败: ' + String(e));
    return false;
  }
}

function fullUrl(arg0, fallbackProto) {
  try {
    if (typeof arg0 === 'string') return arg0;
    if (arg0 && typeof arg0 === 'object') {
      if (arg0.href) return String(arg0.href);
      const proto = String(arg0.protocol || fallbackProto + ':').replace(/:?$/, ':');
      const host = arg0.host || arg0.hostname || '';
      const port = arg0.port ? ':' + arg0.port : '';
      return proto + '//' + host + port + (arg0.path || arg0.pathname || '/');
    }
  } catch (_e) {
    /* 忽略 */
  }
  return '';
}

function patchRequest(mod, proto) {
  if (!mod || typeof mod.request !== 'function' || mod.__wbPatched) return;
  mod.__wbPatched = true;
  const origRequest = mod.request;
  const origGet = mod.get;

  mod.request = function patchedRequest(...args) {
    const url = fullUrl(args[0], proto);
    let interesting = false;
    try {
      interesting = FILTER.test(url);
    } catch (_e) {
      /* 忽略 */
    }

    const req = origRequest.apply(this, args);

    try {
      req.on('response', (res) => {
        const got = [];
        res.on('data', (c) => {
          try {
            got.push(Buffer.from(c));
          } catch (_e) {
            /* 忽略 */
          }
        });
        res.on('end', () => {
          const body = Buffer.concat(got).toString('utf8');
          if (interesting) {
            trySaveToken(body);
            log(`RES ${res.statusCode} ${url}\n  BODY ${body.slice(0, 12000)}`);
          }
        });
      });
    } catch (_e) {
      /* 忽略 */
    }

    return req;
  };

  if (typeof origGet === 'function') {
    mod.get = function patchedGet(...args) {
      const r = mod.request(...args);
      r.end();
      return r;
    };
  }
}

try {
  patchRequest(require('http'), 'http');
  patchRequest(require('https'), 'https');
} catch (_e) {
  /* 忽略 */
}

try {
  if (typeof globalThis.fetch === 'function') {
    const origFetch = globalThis.fetch;
    globalThis.fetch = function patchedFetch(input, init) {
      let url = '';
      try {
        url = typeof input === 'string' ? input : input && input.url ? String(input.url) : '';
      } catch (_e) {
        /* 忽略 */
      }
      let interesting = false;
      try {
        interesting = FILTER.test(url);
      } catch (_e) {
        /* 忽略 */
      }
      const p = origFetch.call(this, input, init);
      if (!interesting) return p;
      return Promise.resolve(p).then((res) => {
        try {
          res
            .clone()
            .text()
            .then((t) => {
              trySaveToken(String(t));
              log(`FETCH RES ${res.status} ${url}\n  BODY ${String(t).slice(0, 12000)}`);
            })
            .catch(() => {});
        } catch (_e) {
          /* 忽略 */
        }
        return res;
      });
    };
  }
} catch (_e) {
  /* 忽略 */
}

log(`==== 抓取层装载 pid=${process.pid} ====`);

module.exports = { trySaveToken };
