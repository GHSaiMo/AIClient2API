import axios from 'axios';
import logger from '../../utils/logger.js';
import { parseProxyUrl } from '../../utils/proxy-utils.js';

const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OAUTH_CLIENT_ID = 'app_2SKx67EdpoN0G6j64rFvigXD';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * 解码 JWT Payload
 * @param {string} token 
 * @returns {Object}
 */
export function decodeJwtPayload(token) {
    try {
        const parts = String(token || '').split('.');
        if (parts.length < 2) return {};
        let payload = parts[1];
        payload += '='.repeat((4 - (payload.length % 4)) % 4);
        const jsonStr = Buffer.from(payload, 'base64').toString('utf8');
        const data = JSON.parse(jsonStr);
        return typeof data === 'object' && data !== null ? data : {};
    } catch {
        return {};
    }
}

/**
 * 判断 JWT 是否接近过期（默认剩余 24 小时以内）
 * @param {string} token 
 * @param {number} skewSeconds 
 * @returns {boolean}
 */
export function isJwtExpiredOrNear(token, skewSeconds = 24 * 60 * 60) {
    const payload = decodeJwtPayload(token);
    const exp = payload.exp;
    if (!exp) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    return exp - nowSeconds <= skewSeconds;
}

/**
 * 刷新 ChatGPT OAuth Access Token
 * @param {string} refreshToken 
 * @param {string} [proxyUrl] 
 * @returns {Promise<Object>}
 */
export async function refreshAccessToken(refreshToken, proxyUrl = null) {
    if (!refreshToken) {
        throw new Error('refresh_token is required');
    }

    const axiosConfig = {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': DEFAULT_USER_AGENT,
            'Accept': 'application/json'
        },
        timeout: 30000
    };

    if (proxyUrl) {
        const proxyConfig = parseProxyUrl(proxyUrl);
        if (proxyConfig) {
            axiosConfig.httpAgent = proxyConfig.httpAgent;
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
            axiosConfig.proxy = false;
        }
    }

    const payload = {
        grant_type: 'refresh_token',
        client_id: OAUTH_CLIENT_ID,
        refresh_token: refreshToken
    };

    logger.info('[ChatGPT Token Service] Refreshing access token via OAuth endpoint...');
    const response = await axios.post(OAUTH_TOKEN_URL, payload, axiosConfig);
    const data = response.data || {};

    if (!data.access_token) {
        throw new Error(`Token refresh failed: missing access_token in response (${JSON.stringify(data)})`);
    }

    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        id_token: data.id_token || null,
        expires_in: data.expires_in || 3600
    };
}

/**
 * 提取配额与恢复时间
 * @param {Array} limitsProgress 
 * @returns {[number, string|null]}
 */
export function extractQuotaAndRestoreAt(limitsProgress) {
    if (!Array.isArray(limitsProgress)) {
        return [0, null];
    }
    for (const item of limitsProgress) {
        if (item && typeof item === 'object' && item.feature_name === 'image_gen') {
            const quota = Number(item.remaining) || 0;
            const resetAfter = item.reset_after ? String(item.reset_after) : null;
            return [quota, resetAfter];
        }
    }
    return [0, null];
}

/**
 * 获取账号详细信息及图片配额
 * @param {string} accessToken 
 * @param {string} [proxyUrl] 
 * @param {Object} [fp] 
 * @returns {Promise<Object>}
 */
export async function fetchUserInfo(accessToken, proxyUrl = null, fp = {}) {
    if (!accessToken) {
        throw new Error('access_token is required to fetch user info');
    }

    const userAgent = fp['user-agent'] || DEFAULT_USER_AGENT;
    const baseHeaders = {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': userAgent,
        'Origin': 'https://chatgpt.com',
        'Referer': 'https://chatgpt.com/',
        'Accept': 'application/json',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'OAI-Device-Id': fp['oai-device-id'] || 'device-uuid',
        'OAI-Session-Id': fp['oai-session-id'] || 'session-uuid',
        'OAI-Language': 'zh-CN'
    };

    const axiosConfig = {
        headers: baseHeaders,
        timeout: 20000
    };

    if (proxyUrl) {
        const proxyConfig = parseProxyUrl(proxyUrl);
        if (proxyConfig) {
            axiosConfig.httpAgent = proxyConfig.httpAgent;
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
            axiosConfig.proxy = false;
        }
    }

    const getMe = async () => {
        const path = '/backend-api/me';
        const res = await axios.get(`https://chatgpt.com${path}`, {
            ...axiosConfig,
            headers: { ...baseHeaders, 'X-OpenAI-Target-Path': path, 'X-OpenAI-Target-Route': path }
        });
        return res.data || {};
    };

    const getInit = async () => {
        const path = '/backend-api/conversation/init';
        const res = await axios.post(`https://chatgpt.com${path}`, {
            gizmo_id: null,
            requested_default_model: null,
            conversation_id: null,
            timezone_offset_min: -480
        }, {
            ...axiosConfig,
            headers: {
                ...baseHeaders,
                'Content-Type': 'application/json',
                'X-OpenAI-Target-Path': path,
                'X-OpenAI-Target-Route': path
            }
        });
        return res.data || {};
    };

    const getDefaultAccount = async () => {
        const path = '/backend-api/accounts/check/v4-2023-04-27';
        const res = await axios.get(`https://chatgpt.com${path}?timezone_offset_min=-480`, {
            ...axiosConfig,
            headers: { ...baseHeaders, 'X-OpenAI-Target-Path': path, 'X-OpenAI-Target-Route': path }
        });
        const payload = res.data || {};
        return payload?.accounts?.default?.account || {};
    };

    const [meRes, initRes, accountRes] = await Promise.allSettled([
        getMe(),
        getInit(),
        getDefaultAccount()
    ]);

    const mePayload = meRes.status === 'fulfilled' ? meRes.value : {};
    const initPayload = initRes.status === 'fulfilled' ? initRes.value : {};
    const defaultAccount = accountRes.status === 'fulfilled' ? accountRes.value : {};

    const planType = String(defaultAccount.plan_type || 'free');
    const limitsProgress = Array.isArray(initPayload.limits_progress) ? initPayload.limits_progress : [];
    const [quota, restoreAt] = extractQuotaAndRestoreAt(limitsProgress);

    return {
        email: mePayload.email || decodeJwtPayload(accessToken)?.email || null,
        user_id: mePayload.id || null,
        type: planType,
        quota,
        limits_progress: limitsProgress,
        default_model_slug: initPayload.default_model_slug || 'auto',
        restore_at: restoreAt,
        status: quota === 0 ? '限流' : '正常'
    };
}
