import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import logger from './logger.js';

/**
 * 解密 macOS Chrome Cookie 字段 (v10 格式)
 * @param {string} hexCiphertext 
 * @param {Buffer} key 
 * @param {Buffer} iv 
 * @returns {string|null}
 */
function decryptMacChromeCookie(hexCiphertext, key, iv) {
    try {
        const buf = Buffer.from(hexCiphertext, 'hex');
        if (buf.length < 3) return null;

        // Chrome macOS 格式：前3字节为 "v10"
        if (buf.slice(0, 3).toString('utf-8') === 'v10') {
            const ciphertext = buf.slice(3);
            if (ciphertext.length % 16 !== 0) return null;

            const cipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
            let decrypted = Buffer.concat([cipher.update(ciphertext), cipher.final()]);

            // PKCS7 去填充已由 Node crypto 处理，但如果是新版本 Chrome 需截断前 32 字节的 domain SHA-256
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
 * 从本地 macOS Chrome 中提取 Google 账号 Cookie
 * @returns {string|null} 格式为 "name=val; name2=val2" 的 Cookie 标头
 */
export function extractMacChromeGoogleCookies() {
    if (process.platform !== 'darwin') {
        return null;
    }

    try {
        // 1. 获取 Keychain 密钥
        const pw = execSync('security find-generic-password -s "Chrome Safe Storage" -w 2>/dev/null', { timeout: 3000 })
            .toString()
            .trim();
        if (!pw) return null;

        const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
        const iv = Buffer.alloc(16, 0x20);

        const home = process.env.HOME || '';
        const chromeCookiesPath = path.join(home, 'Library/Application Support/Google/Chrome/Default/Cookies');
        if (!fs.existsSync(chromeCookiesPath)) {
            logger.warn(`[GeminiCookieExtractor] Chrome cookies database not found at ${chromeCookiesPath}`);
            return null;
        }

        // 2. 避免锁冲突，复制到临时文件
        const tmpDb = `/tmp/gemini_cookie_tmp_${Date.now()}.db`;
        fs.copyFileSync(chromeCookiesPath, tmpDb);

        try {
            const sql = 'SELECT host_key, name, hex(encrypted_value), value FROM cookies WHERE host_key LIKE "%google.com" ORDER BY host_key DESC, creation_utc DESC;';
            const rawOutput = execSync(`/usr/bin/sqlite3 "${tmpDb}" ${JSON.stringify(sql)}`, { timeout: 5000, maxBuffer: 10 * 1024 * 1024 })
                .toString()
                .trim();

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
                        const decrypted = decryptMacChromeCookie(hexVal, key, iv);
                        if (decrypted) cookieMap[name] = decrypted;
                    } else if (plainVal) {
                        cookieMap[name] = plainVal;
                    }
                }
            }

            if (!cookieMap['__Secure-1PSID'] || !cookieMap['__Secure-1PSIDTS']) {
                logger.warn(`[GeminiCookieExtractor] Missing essential cookies (__Secure-1PSID: ${!!cookieMap['__Secure-1PSID']}, __Secure-1PSIDTS: ${!!cookieMap['__Secure-1PSIDTS']})`);
                return null;
            }

            const cookieHeader = Object.entries(cookieMap)
                .map(([k, v]) => `${k}=${v}`)
                .join('; ');

            logger.info(`[GeminiCookieExtractor] Successfully extracted ${Object.keys(cookieMap).length} Google cookies from Chrome.`);
            return cookieHeader;
        } finally {
            try {
                fs.unlinkSync(tmpDb);
            } catch { /* ignore */ }
        }
    } catch (err) {
        logger.error(`[GeminiCookieExtractor] Failed to extract Chrome cookies: ${err.message}`);
        return null;
    }
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

    // 2. 如果在 macOS，原生直读 Chrome 本地 Cookies
    if (process.platform === 'darwin') {
        const localCookies = extractMacChromeGoogleCookies();
        if (localCookies) return localCookies;
    }

    // 3. 如果在 Linux (如 NAS 生产环境) 或配置了 Cookie Bridge
    const bridgeBaseUrl = String(
        config.MAC_COOKIE_BRIDGE_URL ||
        process.env.MAC_COOKIE_BRIDGE_URL ||
        (process.platform === 'linux' ? 'http://192.168.50.9:7899' : '')
    ).trim().replace(/\/+$/, '');

    if (bridgeBaseUrl) {
        try {
            logger.info(`[GeminiCookieExtractor] Fetching Google cookies from Mac bridge: ${bridgeBaseUrl}`);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 6000);
            const res = await fetch(`${bridgeBaseUrl}/api/gemini-cookies`, { signal: controller.signal });
            clearTimeout(timer);

            if (res.ok) {
                const data = await res.json();
                if (data && data.cookies) {
                    return data.cookies;
                }
            }
        } catch (e) {
            logger.debug(`[GeminiCookieExtractor] Bridge fetch failed: ${e.message}`);
        }
    }

    return null;
}
