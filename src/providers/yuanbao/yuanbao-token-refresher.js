import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import logger from '../../utils/logger.js';

function queryCookiesWithPython(dbPath) {
    if (!fs.existsSync(dbPath)) return [];
    try {
        const code = [
            "import sqlite3, shutil, json",
            "p = '" + dbPath + "'",
            "tmp = '/tmp/yb_cookie_query_' + str(abs(hash(p))) + '.db'",
            "shutil.copy2(p, tmp)",
            "conn = sqlite3.connect(tmp)",
            "c = conn.cursor()",
            "c.execute(\"SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%yuanbao%' OR host_key LIKE '%tencent.com%'\")",
            "rows = c.fetchall()",
            "conn.close()",
            "print(json.dumps(rows))"
        ].join("\n");
        const out = execSync("python3", { input: code, encoding: 'utf8', timeout: 5000 });
        return JSON.parse(out.trim() || '[]');
    } catch (e) {
        logger.debug(`[YuanbaoRefresher] SQLite query failed: ${e.message}`);
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
 * 从 Google Chrome 提取腾讯元宝 Cookies
 */
export async function getChromeYuanbaoCookies(preferredProfile = null) {
    if (process.platform !== 'darwin') return null;
    const chromeBase = path.resolve(process.env.HOME || '', 'Library/Application Support/Google/Chrome');
    if (!fs.existsSync(chromeBase)) return null;

    const candidates = [];
    if (preferredProfile) {
        candidates.push(path.join(chromeBase, preferredProfile, 'Cookies'));
    }
    candidates.push(path.join(chromeBase, 'Default/Cookies'));

    try {
        const secOut = execSync('security find-generic-password -ga Chrome 2>&1').toString();
        const password = secOut.match(/password: "(.*)"/)?.[1];
        if (!password) return null;

        const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
        const iv = Buffer.alloc(16, ' ');

        for (const dbPath of candidates) {
            if (!fs.existsSync(dbPath)) continue;
            const rows = queryCookiesWithPython(dbPath);
            if (!rows.length) continue;

            const result = {};
            for (const [name, hexVal] of rows) {
                const dec = cleanDecryptedCookie(Buffer.from(hexVal, 'hex'), key, iv);
                if (dec) result[name] = dec;
            }
            if (result.hy_user && result.hy_token) {
                return result;
            }
        }
        return null;
    } catch (err) {
        logger.debug(`[YuanbaoRefresher] Chrome cookie extraction failed: ${err.message}`);
        return null;
    }
}

/**
 * 从 Ego Lite 浏览器提取腾讯元宝 Cookies
 */
export async function getEgoBrowserYuanbaoCookies(preferredProfile = 'Profile 4') {
    if (process.platform !== 'darwin') return null;
    const egoBase = path.resolve(process.env.HOME || '', 'Library/Application Support/Citro Labs/ego lite');
    if (!fs.existsSync(egoBase)) return null;

    const candidates = [];
    if (preferredProfile) {
        candidates.push(path.join(egoBase, preferredProfile, 'Cookies'));
    }
    candidates.push(path.join(egoBase, 'Default/Cookies'));

    try {
        const secOut = execSync('security find-generic-password -ga "ego" 2>&1').toString();
        const password = secOut.match(/password: "(.*)"/)?.[1];
        if (!password) return null;

        const key = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
        const iv = Buffer.alloc(16, ' ');

        for (const dbPath of candidates) {
            if (!fs.existsSync(dbPath)) continue;
            const rows = queryCookiesWithPython(dbPath);
            if (!rows.length) continue;

            const result = {};
            for (const [name, hexVal] of rows) {
                const dec = cleanDecryptedCookie(Buffer.from(hexVal, 'hex'), key, iv);
                if (dec) result[name] = dec;
            }
            if (result.hy_user && result.hy_token) {
                return result;
            }
        }
        return null;
    } catch (err) {
        logger.debug(`[YuanbaoRefresher] Ego browser cookie extraction failed: ${err.message}`);
        return null;
    }
}

/**
 * 刷新/提取元宝登录凭证
 * @param {Object} config - 提供商配置
 * @returns {Promise<{ hy_user: string, hy_token: string, cookieHeader: string } | null>}
 */
export async function refreshYuanbaoToken(config = {}) {
    logger.info(`[YuanbaoRefresher] Refreshing Yuanbao credentials...`);

    // 1. 如果在 Linux 环境（如飞牛 NAS）或者显式配置了 MAC_COOKIE_BRIDGE_URL，尝试向 Mac Cookie Bridge 拉取
    const bridgeBaseUrl = String(
        config.MAC_COOKIE_BRIDGE_URL ||
        process.env.MAC_COOKIE_BRIDGE_URL ||
        (process.platform === 'linux' ? 'http://192.168.50.9:7899' : '')
    ).trim().replace(/\/+$/, '');

    if (bridgeBaseUrl) {
        try {
            logger.info(`[YuanbaoRefresher] Pulling Yuanbao cookies from Mac bridge at ${bridgeBaseUrl}`);
            const res = await fetch(`${bridgeBaseUrl}/api/yuanbao-cookies`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const data = await res.json();
                if (data && data.ok && data.cookies) {
                    return data.cookies;
                }
            }
        } catch (e) {
            logger.debug(`[YuanbaoRefresher] Bridge query failed: ${e.message}`);
        }
    }

    // 2. Mac 本地原生直取：优先 Ego Lite，其次 Google Chrome
    let cookies = await getEgoBrowserYuanbaoCookies(config.profile || 'Profile 4');
    if (!cookies || !cookies.hy_user) {
        cookies = await getChromeYuanbaoCookies(config.chromeProfile || 'Default');
    }

    if (cookies && cookies.hy_user && cookies.hy_token) {
        const cookieHeader = Object.entries(cookies)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
        logger.info(`[YuanbaoRefresher] Successfully extracted Yuanbao cookies for user: ${cookies.hy_user}`);
        return {
            hy_user: cookies.hy_user,
            hy_token: cookies.hy_token,
            cookies,
            cookieHeader
        };
    }

    logger.warn(`[YuanbaoRefresher] No valid Yuanbao session found in Chrome or Ego Lite.`);
    return null;
}
