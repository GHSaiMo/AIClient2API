import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import logger from './logger.js';

/**
 * 解密 macOS Chromium Cookie 字段 (v10 格式)
 * @param {string} hexCiphertext 
 * @param {Buffer} key 
 * @param {Buffer} iv 
 * @returns {string|null}
 */
function decryptMacCookie(hexCiphertext, key, iv) {
    try {
        const buf = Buffer.from(hexCiphertext, 'hex');
        if (buf.length < 3) return null;

        // macOS Chromium 格式：前3字节为 "v10"
        if (buf.slice(0, 3).toString('utf-8') === 'v10') {
            const ciphertext = buf.slice(3);
            if (ciphertext.length % 16 !== 0) return null;

            const cipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
            let decrypted = Buffer.concat([cipher.update(ciphertext), cipher.final()]);

            // 去除 32 字节的前缀签名
            if (decrypted.length >= 32) {
                decrypted = decrypted.slice(32);
            }
            return decrypted.toString('utf-8');
        }
        return buf.toString('utf-8');
    } catch {
        return null;
    }
}

/**
 * 通用 SQLite 读取与解密 Google Cookies
 */
function extractFromSqlite(dbPath, key, iv) {
    if (!fs.existsSync(dbPath)) return null;
    const tmpDb = `/tmp/gemini_cookie_tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
    try {
        fs.copyFileSync(dbPath, tmpDb);
        const sql = 'SELECT host_key, name, hex(encrypted_value), value FROM cookies WHERE host_key LIKE "%google.com" ORDER BY host_key DESC, creation_utc DESC;';
        const rawOutput = execSync(`/usr/bin/sqlite3 "${tmpDb}" ${JSON.stringify(sql)}`, { timeout: 5000, maxBuffer: 10 * 1024 * 1024 })
            .toString()
            .trim();

        if (!rawOutput) return null;

        const lines = rawOutput.split('\n');
        const cookieMap = {};

        for (const line of lines) {
            const parts = line.split('|');
            if (parts.length >= 3) {
                const name = parts[1];
                const hexVal = parts[2];
                const plainVal = parts[3] || '';

                if (cookieMap[name]) continue;

                if (hexVal) {
                    const decrypted = decryptMacCookie(hexVal, key, iv);
                    if (decrypted) cookieMap[name] = decrypted;
                } else if (plainVal) {
                    cookieMap[name] = plainVal;
                }
            }
        }

        if (!cookieMap['__Secure-1PSID'] || !cookieMap['__Secure-1PSIDTS']) {
            return null;
        }

        const cookieHeader = Object.entries(cookieMap)
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');

        return { cookieMap, cookieHeader };
    } catch {
        return null;
    } finally {
        try { fs.unlinkSync(tmpDb); } catch {}
    }
}

/**
 * 从本地 macOS Chrome 中提取 Google 账号 Cookie
 */
export function getChromeGoogleCookies(profile = 'Default') {
    if (process.platform !== 'darwin') return null;

    try {
        let pw = '';
        try {
            pw = execSync('security find-generic-password -s "Chrome Safe Storage" -w 2>/dev/null', { timeout: 3000 }).toString().trim();
        } catch {}
        if (!pw) return null;

        const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
        const iv = Buffer.alloc(16, 0x20);

        const home = process.env.HOME || '';
        const chromeCookiesPath = path.join(home, 'Library/Application Support/Google/Chrome', profile, 'Cookies');
        const res = extractFromSqlite(chromeCookiesPath, key, iv);
        if (!res) return null;

        return {
            source: `Google Chrome (${profile})`,
            profile,
            browser: 'chrome',
            cookieHeader: res.cookieHeader,
            cookieMap: res.cookieMap
        };
    } catch (err) {
        logger.error(`[GeminiCookieExtractor] Failed to extract Chrome cookies: ${err.message}`);
        return null;
    }
}

/**
 * 兼容旧方法名
 */
export function extractMacChromeGoogleCookies() {
    const data = getChromeGoogleCookies('Default');
    return data?.cookieHeader || null;
}

/**
 * 从本地 macOS ego-browser (ego lite) 中提取 Google 账号 Cookie
 */
export function getEgoGoogleCookies(profile = 'Profile 4') {
    if (process.platform !== 'darwin') return null;

    try {
        let pw = '';
        try {
            const secOut = execSync('security find-generic-password -ga "ego" 2>&1', { timeout: 3000 }).toString();
            pw = secOut.match(/password: "(.*)"/)?.[1] || '';
        } catch {}
        if (!pw) return null;

        const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
        const iv = Buffer.alloc(16, 0x20);

        const home = process.env.HOME || '';
        const egoCookiesPath = path.join(home, 'Library/Application Support/Citro Labs/ego lite', profile, 'Cookies');
        const res = extractFromSqlite(egoCookiesPath, key, iv);
        if (!res) return null;

        const email = res.cookieMap['GAUSR'] || 'hal9000jiuge@gmail.com';

        return {
            email,
            source: `ego-browser (${profile})`,
            profile,
            browser: 'ego',
            cookieHeader: res.cookieHeader,
            cookieMap: res.cookieMap
        };
    } catch (err) {
        logger.error(`[GeminiCookieExtractor] Failed to extract ego lite cookies: ${err.message}`);
        return null;
    }
}

/**
 * 探测本机所有 Google 账号及其对应的 Slot / 浏览器源
 */
export function detectAllLocalGoogleAccounts() {
    const accounts = [];

    // 1. Chrome 探测
    const chrome = getChromeGoogleCookies('Default');
    if (chrome && chrome.cookieMap) {
        const wml = chrome.cookieMap['WML'] || '';
        // 格式: 1790500976838#taojiuzhen@gmail.com:390:0#taoxy0305@gmail.com:972:1...
        if (wml) {
            const matches = [...wml.matchAll(/#([^:]+@[^:]+):\d+:(\d+)/g)];
            for (const m of matches) {
                const email = m[1];
                const slot = parseInt(m[2], 10);
                accounts.push({
                    email,
                    authUser: slot,
                    browser: 'chrome',
                    profile: 'Default',
                    source: `Google Chrome (Slot ${slot})`,
                    cookieHeader: chrome.cookieHeader
                });
            }
        } else {
            accounts.push({
                email: 'taojiuzhen@gmail.com',
                authUser: 0,
                browser: 'chrome',
                profile: 'Default',
                source: 'Google Chrome (Default)',
                cookieHeader: chrome.cookieHeader
            });
        }
    }

    // 2. Ego Browser 探测
    const ego = getEgoGoogleCookies('Profile 4');
    if (ego && ego.cookieHeader) {
        accounts.push({
            email: ego.email || 'hal9000jiuge@gmail.com',
            authUser: null,
            browser: 'ego',
            profile: 'Profile 4',
            source: 'ego-browser (Profile 4)',
            cookieHeader: ego.cookieHeader
        });
    }

    return accounts;
}

/**
 * 获取 Gemini Web 完整 Cookie 标头（支持环境配置、Mac 本地直读、NAS 远程 Bridge）
 * @param {Object} [config] 
 * @returns {Promise<string|null>}
 */
export async function getGeminiWebCookieHeader(config = {}) {
    // 1. 显式配置优先
    if (config.GEMINI_COOKIES || process.env.GEMINI_COOKIES) {
        return (config.GEMINI_COOKIES || process.env.GEMINI_COOKIES).trim();
    }

    // 2. 如果在 macOS，原生直读对应浏览器的 Cookies
    if (process.platform === 'darwin') {
        if (config.browser === 'ego' || (config.customName && config.customName.includes('ego'))) {
            const egoData = getEgoGoogleCookies(config.profile || 'Profile 4');
            if (egoData?.cookieHeader) return egoData.cookieHeader;
        } else {
            const chromeData = getChromeGoogleCookies(config.profile || 'Default');
            if (chromeData?.cookieHeader) return chromeData.cookieHeader;
        }
    }

    // 3. 如果在 Linux (如 NAS 生产环境) 或配置了 Cookie Bridge
    const bridgeBaseUrl = String(
        config.MAC_COOKIE_BRIDGE_URL ||
        process.env.MAC_COOKIE_BRIDGE_URL ||
        (process.platform === 'linux' ? 'http://192.168.50.9:7899' : '')
    ).trim().replace(/\/+$/, '');

    if (bridgeBaseUrl) {
        try {
            const emailParam = config.email ? `?email=${encodeURIComponent(config.email)}` : '';
            logger.info(`[GeminiCookieExtractor] Fetching Google cookies from Mac bridge: ${bridgeBaseUrl}/api/gemini-cookies${emailParam}`);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(`${bridgeBaseUrl}/api/gemini-cookies${emailParam}`, { signal: controller.signal });
            clearTimeout(timer);

            if (res.ok) {
                const data = await res.json();
                if (data && data.cookieHeader) {
                    return data.cookieHeader;
                }
                if (data && data.cookies) {
                    return typeof data.cookies === 'string' ? data.cookies : Object.entries(data.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
                }
            }
        } catch (e) {
            logger.debug(`[GeminiCookieExtractor] Bridge fetch failed: ${e.message}`);
        }
    }

    // 兜底重试 macOS 本地
    if (process.platform === 'darwin') {
        const c = getChromeGoogleCookies();
        if (c?.cookieHeader) return c.cookieHeader;
        const e = getEgoGoogleCookies();
        if (e?.cookieHeader) return e.cookieHeader;
    }

    return null;
}
