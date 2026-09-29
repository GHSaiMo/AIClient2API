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
 * 1. 从 Google Chrome 读取 Cookies (针对 taojiuzhenitunes@gmail.com 及 Chrome 登录账户)
 * 优先检查 preferredProfile / Default，并扫描其他 Profile 目录
 */
export async function getChromeCookies(preferredProfile = null) {
    const chromeBase = path.resolve(process.env.HOME || '', 'Library/Application Support/Google/Chrome');
    if (!fs.existsSync(chromeBase)) return null;

    const candidates = [];
    if (preferredProfile) {
        candidates.push(path.join(chromeBase, preferredProfile, 'Cookies'));
    }
    // 默认优先 Default，其次扫描 Profile 1, Profile 2 等
    candidates.push(path.join(chromeBase, 'Default/Cookies'));
    try {
        const dirs = fs.readdirSync(chromeBase, { withFileTypes: true });
        for (const d of dirs) {
            if (d.isDirectory() && d.name.startsWith('Profile')) {
                const p = path.join(chromeBase, d.name, 'Cookies');
                if (!candidates.includes(p)) candidates.push(p);
            }
        }
    } catch {
        // ignore
    }

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
            if (result.sso) {
                return result;
            }
        }
        return null;
    } catch (err) {
        logger.error(`[GrokRefresher] Chrome cookie extraction failed: ${err.message}`);
        return null;
    }
}

/**
 * 兼容旧接口：从 Google Chrome (Profile 1) 读取 Cookies
 */
export async function getChromeProfile1Cookies() {
    return getChromeCookies('Profile 1');
}

/**
 * 兼容旧接口：Chrome for Testing
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

export async function getEgoBrowserCookies() {
    const dbPath = path.resolve(process.env.HOME || '', 'Library/Application Support/Citro Labs/ego lite/Default/Cookies');
    if (!fs.existsSync(dbPath)) return null;

    try {
        const secOut = execSync('security find-generic-password -ga "ego" 2>&1').toString();
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
        logger.error(`[GrokRefresher] ego lite cookie extraction failed: ${err.message}`);
        return null;
    }
}

/**
 * 根据邮箱或者配置，自动从对应的浏览器（Mac本地或通过Mac Cookie Bridge远程）刷新 Grok SSO
 * @param {Object} config - 提供商配置对象
 * @returns {Promise<{ sso: string, cf_clearance?: string } | null>}
 */
export async function refreshGrokToken(config = {}) {
    const email = (config.email || config.customName || '').toLowerCase().trim();
    logger.info(`[GrokRefresher] Attempting to refresh Grok credentials for email/id: ${email || config.uuid}`);

    let cookies = null;

    // 1. 如果在 Linux 环境（如飞牛 NAS）或者显式配置了 MAC_COOKIE_BRIDGE_URL，优先向 Mac Cookie Bridge 实时拉取
    const bridgeBaseUrl = String(
        config.MAC_COOKIE_BRIDGE_URL ||
        process.env.MAC_COOKIE_BRIDGE_URL ||
        (process.platform === 'linux' ? 'http://192.168.50.9:7899' : '')
    ).trim().replace(/\/+$/, '');

    if (bridgeBaseUrl) {
        try {
            logger.info(`[GrokRefresher] Pulling Grok cookies from Mac bridge at ${bridgeBaseUrl} for ${email || 'default'}`);
            const queryUrl = email
                ? `${bridgeBaseUrl}/api/grok-cookies?email=${encodeURIComponent(email)}`
                : `${bridgeBaseUrl}/api/grok-cookies`;

            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            const res = await fetch(queryUrl, { signal: controller.signal });
            clearTimeout(timer);

            if (res.ok) {
                const data = await res.json();
                if (data && data.ok) {
                    if (data.sso) {
                        cookies = { sso: data.sso, cf_clearance: data.cf_clearance || '' };
                    } else if (data.cookies && email && data.cookies[email]) {
                        cookies = { sso: data.cookies[email].sso, cf_clearance: data.cookies[email].cf_clearance || '' };
                    } else if (data.cookies) {
                        const first = Object.values(data.cookies)[0];
                        if (first?.sso) {
                            cookies = { sso: first.sso, cf_clearance: first.cf_clearance || '' };
                        }
                    }
                }
            } else {
                logger.warn(`[GrokRefresher] Mac bridge returned HTTP ${res.status}`);
            }
        } catch (err) {
            logger.warn(`[GrokRefresher] Failed to pull cookies from Mac bridge: ${err.message}`);
        }
    }

    // 2. 如果桥接未成功获取，且当前处于 macOS 本地，则尝试本地 Keychain 解密兜底
    if (!cookies && process.platform === 'darwin') {
        if (email.includes('taojiuzhenitunes@gmail.com') || email.includes('taojiuzhen@gmail.com')) {
            cookies = await getChromeCookies();
        } else if (email.includes('taoxy0305@gmail.com')) {
            cookies = await getEgoBrowserCookies();
        } else {
            // 未匹配到特定邮箱，按顺序尝试提取
            cookies = await getChromeCookies() || await getEgoBrowserCookies();
        }
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
