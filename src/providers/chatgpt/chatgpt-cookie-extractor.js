import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import logger from '../../utils/logger.js';

const KEYCHAIN_SERVICE_MAP = {
    ego: 'ego',
    chrome: 'Chrome',
};

const BROWSER_BASE_DIR_MAP = {
    ego: path.join('Library', 'Application Support', 'Citro Labs', 'ego lite'),
    chrome: path.join('Library', 'Application Support', 'Google', 'Chrome'),
};

function decryptMacChromiumCookie(hexCiphertext, key, iv) {
    try {
        const buf = Buffer.from(hexCiphertext, 'hex');
        if (buf.length < 3) return null;

        if (buf.slice(0, 3).toString('utf8') === 'v10') {
            const ciphertext = buf.slice(3);
            if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) return null;
            const cipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
            let decrypted = Buffer.concat([cipher.update(ciphertext), cipher.final()]);
            // macOS Chromium v10 cookies prepend a 32-byte domain/hash prefix
            if (decrypted.length >= 32) {
                decrypted = decrypted.slice(32);
            }
            return decrypted.toString('utf8');
        }

        return buf.toString('utf8');
    } catch {
        return null;
    }
}

function getMacKeychainDerivedKey(browser) {
    const serviceName = KEYCHAIN_SERVICE_MAP[browser];
    if (!serviceName) {
        throw new Error(`Unsupported browser for keychain lookup: ${browser}`);
    }
    const secOut = execSync(`security find-generic-password -ga ${JSON.stringify(serviceName)} 2>&1`, {
        timeout: 4000,
    }).toString();
    const match = secOut.match(/password:\s*"([^"]*)"/);
    if (!match || !match[1]) {
        throw new Error(`Unable to read keychain password for ${serviceName}`);
    }
    return {
        key: crypto.pbkdf2Sync(match[1], 'saltysalt', 1003, 16, 'sha1'),
        iv: Buffer.alloc(16, ' '),
    };
}

/**
 * Parse a Cookie header string into a key-value map.
 * @param {string} cookieHeader
 * @returns {Record<string, string>}
 */
export function parseCookieHeader(cookieHeader) {
    const map = {};
    if (!cookieHeader || typeof cookieHeader !== 'string') return map;

    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const name = part.slice(0, idx).trim();
        const value = part.slice(idx + 1).trim();
        if (name) {
            map[name] = value;
        }
    }
    return map;
}

/**
 * Serialize a cookie key-value map back into a Cookie header string.
 * @param {Record<string, string>} cookieMap
 * @returns {string}
 */
export function serializeCookieMap(cookieMap) {
    return Object.entries(cookieMap || {})
        .filter(([k, v]) => k && v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

/**
 * Extract a single cookie value by name from a Cookie header string.
 * @param {string} cookieHeader
 * @param {string} cookieName
 * @returns {string|null}
 */
export function extractCookieValue(cookieHeader, cookieName) {
    if (!cookieHeader || !cookieName) return null;
    const map = parseCookieHeader(cookieHeader);
    return map[cookieName] || null;
}

/**
 * Check whether a cookie map holds a NextAuth ChatGPT session token (single or chunked).
 * @param {Record<string, string>} cookieMap
 * @returns {boolean}
 */
export function hasChatGPTSessionCookie(cookieMap) {
    if (!cookieMap || typeof cookieMap !== 'object') return false;
    return Boolean(
        cookieMap['__Secure-next-auth.session-token'] ||
        (cookieMap['__Secure-next-auth.session-token.0'] && cookieMap['__Secure-next-auth.session-token.1'])
    );
}

/**
 * Merge Set-Cookie response headers into an existing Cookie header string.
 * Handles comma-joined Set-Cookie strings returned by Fetch/Undici.
 * @param {string} existingCookieHeader
 * @param {string|string[]|null} setCookieHeaders
 * @returns {string}
 */
export function mergeSetCookieHeaders(existingCookieHeader, setCookieHeaders) {
    const map = parseCookieHeader(existingCookieHeader);
    if (!setCookieHeaders) {
        return serializeCookieMap(map);
    }

    const rawList = Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : String(setCookieHeaders).split(/,(?=\s*[A-Za-z0-9_!#$%&'*+.^`|~-]+=)/);

    for (const rawEntry of rawList) {
        const firstPair = String(rawEntry || '').split(';')[0].trim();
        const eqIdx = firstPair.indexOf('=');
        if (eqIdx <= 0) continue;
        const name = firstPair.slice(0, eqIdx).trim();
        const value = firstPair.slice(eqIdx + 1).trim();
        if (!name) continue;
        if (value === '' || value === 'deleted') {
            delete map[name];
        } else {
            map[name] = value;
        }
    }

    return serializeCookieMap(map);
}

/**
 * Extract ChatGPT (`chatgpt.com`) cookies from a macOS Chromium profile.
 * @param {{ browser?: 'ego'|'chrome', profile?: string }} [options]
 * @returns {{ browser: string, profile: string, source: string, cookieMap: Record<string, string>, cookieHeader: string } | null}
 */
export function extractChatGPTCookiesFromBrowser({ browser = 'ego', profile = 'Profile 4' } = {}) {
    if (process.platform !== 'darwin') return null;

    const relBase = BROWSER_BASE_DIR_MAP[browser];
    if (!relBase) return null;

    const dbPath = path.join(os.homedir(), relBase, profile, 'Cookies');
    if (!fs.existsSync(dbPath)) return null;

    const tmpDb = `/tmp/chatgpt_cookie_tmp_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
    try {
        const { key, iv } = getMacKeychainDerivedKey(browser);
        fs.copyFileSync(dbPath, tmpDb);
        const sql = [
            'SELECT host_key, name, hex(encrypted_value), value',
            'FROM cookies',
            "WHERE host_key LIKE '%chatgpt.com'",
            "ORDER BY CASE WHEN host_key = 'chatgpt.com' THEN 0 ELSE 1 END, creation_utc DESC;",
        ].join(' ');

        const rawOutput = execSync(`/usr/bin/sqlite3 ${JSON.stringify(tmpDb)} ${JSON.stringify(sql)}`, {
            timeout: 5000,
            maxBuffer: 10 * 1024 * 1024,
        }).toString().trim();

        if (!rawOutput) return null;

        const cookieMap = {};
        for (const line of rawOutput.split('\n')) {
            const parts = line.split('|');
            if (parts.length < 3) continue;
            const name = parts[1];
            const hexVal = parts[2];
            const plainVal = parts[3] || '';
            if (!name || cookieMap[name]) continue;

            const value = hexVal ? decryptMacChromiumCookie(hexVal, key, iv) : plainVal;
            if (value) {
                cookieMap[name] = value;
            }
        }

        if (!hasChatGPTSessionCookie(cookieMap)) {
            return null;
        }

        return {
            browser,
            profile,
            source: `${browser === 'ego' ? 'ego-lite' : 'chrome'} (${profile})`,
            cookieMap,
            cookieHeader: serializeCookieMap(cookieMap),
        };
    } catch (err) {
        logger.debug(`[ChatGPTCookieExtractor] Failed to extract ${browser} (${profile}) cookies: ${err.message}`);
        return null;
    } finally {
        try {
            fs.unlinkSync(tmpDb);
        } catch {
            // ignore cleanup errors
        }
    }
}

function listProfileCandidates(browser) {
    const relBase = BROWSER_BASE_DIR_MAP[browser];
    if (!relBase) return [];
    const baseDir = path.join(os.homedir(), relBase);
    if (!fs.existsSync(baseDir)) return [];

    const preferred = browser === 'ego'
        ? ['Profile 4', 'Default', 'Profile 1', 'Profile 2', 'Profile 3']
        : ['Default', 'Profile 1', 'Profile 2', 'Profile 3', 'Profile 4'];

    const discovered = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && (d.name === 'Default' || d.name.startsWith('Profile ')))
        .map(d => d.name);

    return [...new Set([...preferred, ...discovered])];
}

/**
 * Scan Ego Lite and Chrome profiles on macOS and return the first valid ChatGPT session.
 * @param {{ preferredBrowser?: 'ego'|'chrome', preferredProfile?: string }} [options]
 */
export function extractChatGPTSessionCookies({ preferredBrowser = 'ego', preferredProfile = 'Profile 4' } = {}) {
    if (process.platform !== 'darwin') return null;

    if (preferredBrowser && preferredProfile) {
        const direct = extractChatGPTCookiesFromBrowser({ browser: preferredBrowser, profile: preferredProfile });
        if (direct) return direct;
    }

    const browsers = preferredBrowser === 'chrome' ? ['chrome', 'ego'] : ['ego', 'chrome'];
    for (const browser of browsers) {
        for (const profile of listProfileCandidates(browser)) {
            if (browser === preferredBrowser && profile === preferredProfile) continue;
            const extracted = extractChatGPTCookiesFromBrowser({ browser, profile });
            if (extracted) return extracted;
        }
    }

    return null;
}

export default {
    parseCookieHeader,
    serializeCookieMap,
    extractCookieValue,
    hasChatGPTSessionCookie,
    mergeSetCookieHeaders,
    extractChatGPTCookiesFromBrowser,
    extractChatGPTSessionCookies,
};
