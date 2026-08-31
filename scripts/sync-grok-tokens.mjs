import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const POOLS_PATH = path.resolve(ROOT, 'configs/provider_pools.json');

function queryCookiesWithPython(dbPath) {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const code = [
      "import sqlite3, shutil, json",
      "p = '" + dbPath + "'",
      "tmp = '/tmp/cookie_query_' + str(abs(hash(p))) + '.db'",
      "shutil.copy2(p, tmp)",
      "conn = sqlite3.connect(tmp)",
      "c = conn.cursor()",
      "c.execute(\"SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%grok.com%' AND name IN ('sso', 'sso-rw', 'cf_clearance')\")",
      "rows = c.fetchall()",
      "conn.close()",
      "print(json.dumps(rows))"
    ].join("\n");
    const out = execSync("python3", { input: code, encoding: 'utf8', timeout: 5000 });
    return JSON.parse(out.trim() || '[]');
  } catch {
    return [];
  }
}

function cleanDecryptedCookie(buf, key, iv) {
  try {
    if (buf.slice(0, 3).toString() === 'v10') buf = buf.slice(3);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    let dec = Buffer.concat([decipher.update(buf), decipher.final()]);
    // macOS Chromium Cookies 拥有 32 字节的前缀签名
    if (dec.length > 32) {
      return dec.slice(32).toString('utf8');
    }
    return dec.toString('utf8');
  } catch {
    return '';
  }
}

// 1. 解密 Chrome (Profile 1) Cookies -> 账户: taojiuzhen@gmail.com
async function getChromeProfile1Cookies() {
  const dbPath = path.resolve(process.env.HOME, 'Library/Application Support/Google/Chrome/Profile 1/Cookies');
  if (!fs.existsSync(dbPath)) return null;

  try {
    const secOut = execSync('security find-generic-password -ga Chrome 2>&1').toString();
    const password = secOut.match(/password: "(.*)"/)?.[1];
    if (!password) return null;

    const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, ' ');

    const rows = queryCookiesWithPython(dbPath);
    if (!rows.length) return null;

    const result = {};
    for (const [name, hexVal] of rows) {
      const dec = cleanDecryptedCookie(Buffer.from(hexVal, 'hex'), key, iv);
      if (dec) result[name] = dec;
    }
    return result;
  } catch (err) {
    console.error('[Chrome] Extraction failed:', err.message);
    return null;
  }
}

// 2. 解密 Chrome for Testing (message-runtime 常驻进程) -> 账户: taojiuzhenitunes@gmail.com
async function getChromeForTestingCookies() {
  const dbPath = path.resolve('/Users/hal9000/Projects/message-runtime/data/playwright-profiles/truthsocial/Default/Cookies');
  if (!fs.existsSync(dbPath)) return null;

  try {
    const key = crypto.pbkdf2Sync('mock_password', 'saltysalt', 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, ' ');

    const rows = queryCookiesWithPython(dbPath);
    if (!rows.length) return null;

    const result = {};
    for (const [name, hexVal] of rows) {
      const dec = cleanDecryptedCookie(Buffer.from(hexVal, 'hex'), key, iv);
      if (dec) result[name] = dec;
    }
    return result;
  } catch (err) {
    console.error('[Chrome for Testing] Extraction failed:', err.message);
    return null;
  }
}

// 3. 从 ego-browser (ego lite) 提取 Cookies -> 账户: taoxy0305@gmail.com
function getEgoBrowserCookies() {
  try {
    const script = `
const task = await useOrCreateTaskSpace('extract grok cookies');
await openOrReuseTab('https://grok.com/', { wait: false });
const cookieData = await cdp('Network.getCookies', { urls: ['https://grok.com/'] });
const result = {};
for (const c of cookieData.cookies) {
  if (['sso', 'sso-rw', 'cf_clearance'].includes(c.name)) {
    result[c.name] = c.value;
  }
}
cliLog('COOKIE_RESULT:' + JSON.stringify(result));
await completeTaskSpace(task.id, { keep: false });
`;
    const proc = spawnSync('ego-browser', ['nodejs'], { input: script, encoding: 'utf8', timeout: 30000 });
    const text = (proc.stdout || '') + '\n' + (proc.stderr || '');
    const match = text.match(/COOKIE_RESULT:(\{.+?\})/);
    if (match) {
      return JSON.parse(match[1].trim());
    }
  } catch (err) {
    console.error('[ego-browser] Extraction failed:', err.message);
  }
  return null;
}

async function main() {
  console.log('=== 开始同步 Grok 浏览器登录态到 AIClient2API 账号池 ===\n');

  const targets = [
    {
      source: 'Google Chrome (Profile 1)',
      email: 'taojiuzhen@gmail.com',
      fetcher: getChromeProfile1Cookies
    },
    {
      source: 'Chrome for Testing',
      email: 'taojiuzhenitunes@gmail.com',
      fetcher: getChromeForTestingCookies
    },
    {
      source: 'ego-browser',
      email: 'taoxy0305@gmail.com',
      fetcher: getEgoBrowserCookies
    }
  ];

  // 读取现有 provider_pools.json
  const pools = JSON.parse(fs.readFileSync(POOLS_PATH, 'utf8'));
  let grokList = pools['grok-web'] || [];

  for (const t of targets) {
    console.log(`正在检查 [${t.source}] (${t.email})...`);
    const cookies = await t.fetcher();
    if (!cookies || !cookies.sso) {
      console.log(`  -> 未提取到有效 SSO，跳过`);
      continue;
    }

    const ssoToken = cookies.sso;
    const cfClearance = cookies.cf_clearance || '';
    let sessionId = '';
    try {
      const payload = JSON.parse(Buffer.from(ssoToken.split('.')[1], 'base64').toString());
      sessionId = payload.session_id;
    } catch {}

    console.log(`  -> 成功提取 SSO! Session: ${sessionId}`);

    // 在已有池中查找匹配项（优先邮箱匹配，其次 Session ID 匹配）
    let item = grokList.find(p => p.email === t.email || (sessionId && p.GROK_COOKIE_TOKEN?.includes(sessionId)));

    if (item) {
      console.log(`  -> 更新已有节点 [${item.customName || item.uuid}]`);
      item.GROK_COOKIE_TOKEN = ssoToken;
      if (cfClearance) item.GROK_CF_CLEARANCE = cfClearance;
      item.email = t.email;
      item.customName = t.email;
      item.isHealthy = true;
      item.errorCount = 0;
      item.lastErrorMessage = null;
      item.lastHealthCheckTime = new Date().toISOString();
    } else {
      console.log(`  -> 新建节点: ${t.email}`);
      const newUuid = crypto.randomUUID();
      grokList.push({
        GROK_COOKIE_TOKEN: ssoToken,
        uuid: newUuid,
        email: t.email,
        customName: t.email,
        checkModelName: 'grok-4.1-mini',
        checkHealth: false,
        isHealthy: true,
        isDisabled: false,
        lastUsed: null,
        usageCount: 0,
        errorCount: 0,
        lastErrorTime: null,
        lastHealthCheckTime: new Date().toISOString(),
        lastErrorMessage: null,
        GROK_BASE_URL: 'https://grok.com',
        GROK_CF_CLEARANCE: cfClearance,
        GROK_USER_AGENT: '',
        needsRefresh: false,
        refreshCount: 0
      });
    }
  }

  // 整理 grokList：移除历史杂乱无效的废弃未命名节点
  pools['grok-web'] = grokList.filter(p => {
    // 保留有对应 email 或是合法当前 token 的节点
    return p.email && p.GROK_COOKIE_TOKEN && !p.GROK_COOKIE_TOKEN.includes('\\u0014');
  });

  fs.writeFileSync(POOLS_PATH, JSON.stringify(pools, null, 2), 'utf8');
  console.log(`\n✓ 同步完成！当前已生效的 Grok 账号池列表:`);
  pools['grok-web'].forEach((p, idx) => {
    console.log(`  [${idx + 1}] 账号: ${p.email} | 节点名: ${p.customName} | UUID: ${p.uuid}`);
  });
}

main().catch(console.error);
