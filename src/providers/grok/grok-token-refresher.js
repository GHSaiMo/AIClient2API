import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync, spawnSync } from 'child_process';
import logger from '../../utils/logger.js';

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
    } catch (e) {
        logger.debug(`[GrokRefresher] SQLite query failed: ${e.message}`);
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

/**
 * 1. 从 Google Chrome (Profile 1) 读取 Cookies (针对 taojiuzhen@gmail.com)
 */
export async function getChromeProfile1Cookies() {
    const dbPath = path.resolve(process.env.HOME || '', 'Library/Application Support/Google/Chrome/Profile 1/Cookies');
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
        logger.error(`[GrokRefresher] Chrome Profile 1 cookie extraction failed: ${err.message}`);
        return null;
    }
}

/**
 * 2. 从 Chrome for Testing (message-runtime 常驻进程) 读取 Cookies (针对 taojiuzhenitunes@gmail.com)
 */
export async function getChromeForTestingCookies() {
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
        logger.error(`[GrokRefresher] Chrome for Testing cookie extraction failed: ${err.message}`);
        return null;
    }
}

/**
 * 3. 从 ego-browser 提取 Cookies (针对 taoxy0305@gmail.com)
 */
export async function getEgoBrowserCookies() {
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
        logger.error(`[GrokRefresher] ego-browser cookie extraction failed: ${err.message}`);
    }
    return null;
}

/**
 * 根据邮箱或者配置，自动从对应的浏览器刷新 Grok SSO
 * @param {Object} config - 提供商配置对象
 * @returns {Promise<{ sso: string, cf_clearance?: string } | null>}
 */
export async function refreshGrokToken(config = {}) {
    const email = (config.email || config.customName || '').toLowerCase().trim();
    logger.info(`[GrokRefresher] Attempting to refresh Grok credentials for email/id: ${email || config.uuid}`);

    let cookies = null;
    if (email.includes('taojiuzhen@gmail.com')) {
        cookies = await getChromeProfile1Cookies();
    } else if (email.includes('taojiuzhenitunes@gmail.com')) {
        cookies = await getChromeForTestingCookies();
    } else if (email.includes('taoxy0305@gmail.com')) {
        cookies = await getEgoBrowserCookies();
    } else {
        // 未匹配到特定邮箱，按顺序尝试提取
        cookies = await getChromeProfile1Cookies() || await getChromeForTestingCookies() || await getEgoBrowserCookies();
    }

    if (cookies && cookies.sso) {
        logger.info(`[GrokRefresher] Successfully refreshed Grok SSO for ${email || config.uuid}`);
        return {
            sso: cookies.sso,
            cf_clearance: cookies.cf_clearance || ''
        };
    }

    logger.warn(`[GrokRefresher] Failed to refresh Grok credentials for ${email || config.uuid}`);
    return null;
}
