import axios from 'axios';
import logger from '../../utils/logger.js';
import { parseProxyUrl } from '../../utils/proxy-utils.js';

/**
 * 将 Base64 字符串或 Data URI 转换为 Buffer
 * @param {string} imageStr 
 * @returns {Buffer}
 */
export function decodeImageBase64(imageStr) {
    if (!imageStr || typeof imageStr !== 'string') {
        throw new Error('Invalid image string');
    }
    const cleanStr = imageStr.includes(',') ? imageStr.split(',')[1] : imageStr;
    return Buffer.from(cleanStr.trim(), 'base64');
}

/**
 * 快速纯 JS 解析常用图片尺寸 (PNG, JPEG, GIF, WebP)
 * @param {Buffer} buffer 
 * @returns {{width: number, height: number}}
 */
export function getImageDimensions(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
        return { width: 1024, height: 1024 };
    }

    try {
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
            if (buffer.length >= 24) {
                const width = buffer.readUInt32BE(16);
                const height = buffer.readUInt32BE(20);
                if (width > 0 && height > 0) return { width, height };
            }
        }

        // GIF: GIF87a / GIF89a
        if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
            if (buffer.length >= 10) {
                const width = buffer.readUInt16LE(6);
                const height = buffer.readUInt16LE(8);
                if (width > 0 && height > 0) return { width, height };
            }
        }

        // JPEG: FF D8 FF
        if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
            let offset = 2;
            while (offset < buffer.length - 8) {
                if (buffer[offset] !== 0xFF) {
                    offset++;
                    continue;
                }
                const marker = buffer[offset + 1];
                // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
                if (marker === 0xC0 || marker === 0xC1 || marker === 0xC2) {
                    const height = buffer.readUInt16BE(offset + 5);
                    const width = buffer.readUInt16BE(offset + 7);
                    if (width > 0 && height > 0) return { width, height };
                }
                const length = buffer.readUInt16BE(offset + 2);
                offset += 2 + length;
            }
        }

        // WebP: RIFF ... WEBP
        if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
            const chunkType = buffer.toString('ascii', 12, 16);
            if (chunkType === 'VP8 ' && buffer.length >= 30) {
                const width = buffer.readUInt16LE(26) & 0x3fff;
                const height = buffer.readUInt16LE(28) & 0x3fff;
                if (width > 0 && height > 0) return { width, height };
            } else if (chunkType === 'VP8L' && buffer.length >= 25) {
                const b1 = buffer[21];
                const b2 = buffer[22];
                const b3 = buffer[23];
                const b4 = buffer[24];
                const width = 1 + (((b2 & 0x3f) << 8) | b1);
                const height = 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
                if (width > 0 && height > 0) return { width, height };
            }
        }
    } catch {
        // ignore parse error, fallback
    }

    return { width: 1024, height: 1024 };
}

/**
 * 根据 Buffer 头判断 MIME 类型
 * @param {Buffer} buffer 
 * @returns {string}
 */
export function getImageMimeType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
        return 'image/png';
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
        return 'image/png';
    }
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) {
        return 'image/jpeg';
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
        return 'image/gif';
    }
    if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        return 'image/webp';
    }
    return 'image/png';
}

/**
 * 上传图片到 ChatGPT 后端并在 Azure Blob 确认
 * @param {Object} options
 * @param {string|Buffer} options.image - base64 字符串或 Buffer
 * @param {string} [options.fileName] - 文件名
 * @param {string} options.accessToken - 用户 Bearer Token
 * @param {string} [options.proxyUrl] - 代理地址
 * @param {Object} [options.headers] - 基础请求头
 * @returns {Promise<Object>}
 */
export async function uploadImageToChatGPT({
    image,
    fileName = 'image.png',
    accessToken,
    proxyUrl = null,
    headers = {}
}) {
    const data = Buffer.isBuffer(image) ? image : decodeImageBase64(image);
    const { width, height } = getImageDimensions(data);
    const mimeType = getImageMimeType(data);

    const baseHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        'Origin': 'https://chatgpt.com',
        'Referer': 'https://chatgpt.com/',
        'Accept': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        ...headers
    };

    const axiosConfig = {
        headers: baseHeaders,
        timeout: 60000
    };

    if (proxyUrl) {
        const proxyConfig = parseProxyUrl(proxyUrl);
        if (proxyConfig) {
            axiosConfig.httpAgent = proxyConfig.httpAgent;
            axiosConfig.httpsAgent = proxyConfig.httpsAgent;
            axiosConfig.proxy = false;
        }
    }

    // 1. 请求上传凭证
    const path = '/backend-api/files';
    const initRes = await axios.post('https://chatgpt.com' + path, {
        file_name: fileName,
        file_size: data.length,
        use_case: 'multimodal',
        width,
        height
    }, {
        ...axiosConfig,
        headers: {
            ...baseHeaders,
            'Content-Type': 'application/json',
            'X-OpenAI-Target-Path': path,
            'X-OpenAI-Target-Route': path
        }
    });

    const uploadMeta = initRes.data || {};
    if (!uploadMeta.upload_url || !uploadMeta.file_id) {
        throw new Error(`Failed to obtain upload URL from ChatGPT: ${JSON.stringify(uploadMeta)}`);
    }

    // 2. 直传 Azure Blob
    await axios.put(uploadMeta.upload_url, data, {
        ...axiosConfig,
        headers: {
            'Content-Type': mimeType,
            'x-ms-blob-type': 'BlockBlob',
            'x-ms-version': '2020-04-08',
            'Origin': 'https://chatgpt.com',
            'Referer': 'https://chatgpt.com/',
            'User-Agent': baseHeaders['User-Agent']
        },
        timeout: 120000
    });

    // 3. 确认上传完成
    const uploadedPath = `/backend-api/files/${uploadMeta.file_id}/uploaded`;
    await axios.post('https://chatgpt.com' + uploadedPath, {}, {
        ...axiosConfig,
        headers: {
            ...baseHeaders,
            'Content-Type': 'application/json',
            'X-OpenAI-Target-Path': uploadedPath,
            'X-OpenAI-Target-Route': uploadedPath
        }
    });

    return {
        file_id: uploadMeta.file_id,
        file_name: fileName,
        file_size: data.length,
        mime_type: mimeType,
        width,
        height
    };
}
