import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
  getChromeCookies,
  getChromeProfile1Cookies,
  getEgoBrowserCookies
} from '../src/providers/grok/grok-token-refresher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const POOLS_PATH = path.resolve(ROOT, 'configs/provider_pools.json');

function extractSessionId(token) {
  try {
    if (!token) return '';
    const parts = token.split('.');
    if (parts.length < 2) return '';
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return payload.session_id || '';
  } catch {
    return '';
  }
}

async function extractAllLocalCookies() {
  const [chromeCookies, chrome1, ego] = await Promise.all([
    getChromeCookies().catch(() => null),
    getChromeProfile1Cookies().catch(() => null),
    getEgoBrowserCookies().catch(() => null),
  ]);

  const result = {};

  // 1. Google Chrome Default (包含 taoxy0305@gmail.com)
  if (chromeCookies?.sso) {
    result['taoxy0305@gmail.com'] = {
      email: 'taoxy0305@gmail.com',
      sso: chromeCookies.sso,
      cf_clearance: chromeCookies.cf_clearance || '',
      session_id: extractSessionId(chromeCookies.sso),
      source: 'Google Chrome'
    };
  }

  // 2. Google Chrome Profile 1 (备用 profile，若与 Default 互斥)
  if (chrome1?.sso && chrome1.sso !== chromeCookies?.sso) {
    result['taojiuzhen@gmail.com'] = {
      email: 'taojiuzhen@gmail.com',
      sso: chrome1.sso,
      cf_clearance: chrome1.cf_clearance || '',
      session_id: extractSessionId(chrome1.sso),
      source: 'Chrome Profile 1'
    };
  }

  // 3. ego-browser / Ego lite (包含 taojiuzhenitunes@gmail.com)
  if (ego?.sso) {
    result['taojiuzhenitunes@gmail.com'] = {
      email: 'taojiuzhenitunes@gmail.com',
      sso: ego.sso,
      cf_clearance: ego.cf_clearance || '',
      session_id: extractSessionId(ego.sso),
      source: 'Ego lite'
    };
  }

  return result;
}

async function main() {
  console.log('=== 开始同步 Grok Web 浏览器登录态到 AIClient2API 账号池 ===\n');

  // 1. 如果在 Linux 环境（如飞牛 NAS）或配置了 MAC_COOKIE_BRIDGE_URL，优先从 Mac Cookie Bridge 批量拉取
  const bridgeBaseUrl = String(
    process.env.MAC_COOKIE_BRIDGE_URL ||
    (process.platform === 'linux' ? 'http://192.168.50.9:7899' : '')
  ).trim().replace(/\/+$/, '');

  let cookiesMap = null;
  if (bridgeBaseUrl) {
    try {
      console.log(`正在从 Mac Cookie Bridge (${bridgeBaseUrl}) 实时拉取最新登录态...`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(`${bridgeBaseUrl}/api/grok-cookies`, { signal: controller.signal });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        if (data && data.ok && data.cookies) {
          cookiesMap = data.cookies;
          console.log(`✓ 成功从 Mac 桥接获取到 ${Object.keys(cookiesMap).length} 个账号的最新凭据\n`);
        }
      } else {
        console.warn(`! Mac 桥接响应异常: HTTP ${res.status}`);
      }
    } catch (err) {
      console.warn(`! 从 Mac 桥接拉取失败: ${err.message}`);
    }
  }

  // 2. 本地 macOS 提取兜底或合并
  if (process.platform === 'darwin') {
    const localCookies = await extractAllLocalCookies();
    cookiesMap = { ...(cookiesMap || {}), ...localCookies };
  }

  if (!cookiesMap || Object.keys(cookiesMap).length === 0) {
    console.error('❌ 未从 Chrome、Ego lite 或 Mac 桥接获取到任何有效的 Grok 登录态！');
    process.exit(1);
  }

  console.log(`已成功提取 ${Object.keys(cookiesMap).length} 个 Grok 账号:`);
  for (const [email, info] of Object.entries(cookiesMap)) {
    console.log(`  - ${email} (来源: ${info.source || '未知'}, Session: ${info.session_id})`);
  }

  // 3. 更新 provider_pools.json
  const pools = JSON.parse(fs.readFileSync(POOLS_PATH, 'utf8'));
  let grokList = pools['grok-web'] || [];

  // 清除历史无效/占位默认账号（如 user@grok.com）
  grokList = grokList.filter(p => {
    if (p.email === 'user@grok.com') {
      console.log(`\n🧹 移除历史默认占位节点: ${p.uuid} (email: user@grok.com)`);
      return false;
    }
    return true;
  });

  for (const [email, info] of Object.entries(cookiesMap)) {
    const ssoToken = info.sso;
    const cfClearance = info.cf_clearance || '';
    const sessionId = info.session_id || extractSessionId(ssoToken);

    // 匹配已有节点（邮箱匹配或 Session ID 匹配）
    let item = grokList.find(p =>
      (p.email && p.email.toLowerCase() === email.toLowerCase()) ||
      (sessionId && extractSessionId(p.GROK_COOKIE_TOKEN) === sessionId)
    );

    if (item) {
      console.log(`\n🔄 更新已有 Grok 节点 [${item.uuid}] -> ${email}`);
      item.GROK_COOKIE_TOKEN = ssoToken;
      if (cfClearance) item.GROK_CF_CLEARANCE = cfClearance;
      item.email = email;
      item.customName = `${email} (${info.source || 'Web'})`;
      item.isHealthy = true;
      item.isDisabled = false;
      item.needsRefresh = false;
      item.errorCount = 0;
      item.lastErrorMessage = null;
      item.lastRefreshTime = Date.now();
      item.lastHealthCheckTime = new Date().toISOString();
    } else {
      console.log(`\n➕ 新增 Grok 节点 -> ${email}`);
      const newUuid = crypto.randomUUID();
      grokList.push({
        uuid: newUuid,
        email: email,
        customName: `${email} (${info.source || 'Web'})`,
        GROK_COOKIE_TOKEN: ssoToken,
        GROK_CF_CLEARANCE: cfClearance,
        GROK_BASE_URL: 'https://grok.com',
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
        needsRefresh: false,
        refreshCount: 0,
        _lastSelectionSeq: 0,
        lastRefreshTime: Date.now()
      });
    }
  }

  pools['grok-web'] = grokList;
  fs.writeFileSync(POOLS_PATH, JSON.stringify(pools, null, 2) + '\n', 'utf8');

  console.log(`\n✓ 本地 configs/provider_pools.json 更新成功！当前 Grok Web 账号池:`);
  pools['grok-web'].forEach((p, idx) => {
    console.log(`  [${idx + 1}] 邮箱: ${p.email} | 节点名: ${p.customName} | 状态: ${p.isHealthy ? '健康' : '异常'} | UUID: ${p.uuid}`);
  });

  // 4. 同步至飞牛 NAS 生产环境 (192.168.50.39)
  if (process.platform === 'darwin') {
    console.log('\n--- 同步至 NAS 生产环境 (192.168.50.39) ---');
    try {
      console.log('[NAS Sync] 正在推送 configs/provider_pools.json 到 NAS ...');
      execSync(`scp configs/provider_pools.json nas:/vol1/1000/apps/AIClient2API/configs/provider_pools.json`, { stdio: 'inherit', cwd: ROOT });

      console.log('[NAS Sync] 重启 NAS aiclient2api 服务 ...');
      execSync(`ssh nas "echo jz0305 | sudo -S systemctl restart aiclient2api"`, { stdio: 'inherit', cwd: ROOT });

      console.log('✓ NAS 生产服务同步并重启成功！');
    } catch (err) {
      console.error('[NAS Sync 失败]', err.message);
    }
  }
}

main().catch(err => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
