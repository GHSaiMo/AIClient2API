import { describe, it, expect } from '@jest/globals';
import crypto from 'crypto';
import {
    parsePowResources,
    buildPowConfig,
    powGenerate,
    buildLegacyRequirementsToken,
    buildProofToken,
    DEFAULT_POW_SCRIPT
} from '../../src/providers/chatgpt/chatgpt-pow.js';
import { solveTurnstileToken } from '../../src/providers/chatgpt/chatgpt-turnstile.js';
import {
    decodeJwtPayload,
    isJwtExpiredOrNear,
    extractQuotaAndRestoreAt
} from '../../src/providers/chatgpt/chatgpt-token-service.js';
import {
    decodeImageBase64,
    getImageDimensions,
    getImageMimeType
} from '../../src/providers/chatgpt/chatgpt-file-service.js';
import {
    ChatGPTWebService,
    ImageContentPolicyError,
    CHATGPT_WEB_MODELS
} from '../../src/providers/chatgpt/chatgpt-web-core.js';
import { ChatGPTWebApiServiceAdapter } from '../../src/providers/adapter.js';
import { MODEL_PROVIDER, MODEL_PROTOCOL_PREFIX } from '../../src/utils/constants.js';
import { getProtocolPrefix } from '../../src/utils/common.js';
import { ConverterFactory } from '../../src/converters/ConverterFactory.js';
import '../../src/converters/register-converters.js';

describe('ChatGPT Web Reverse Protocol & Pool Integration Suite', () => {

    describe('1. Sentinel PoW (Proof of Work) Solver', () => {
        it('should extract script sources and data-build from HTML', () => {
            const sampleHtml = `
                <!DOCTYPE html>
                <html data-build="c/2026-08-24-12345/_">
                <head>
                    <script src="https://chatgpt.com/backend-api/sentinel/sdk.js"></script>
                    <script src="https://cdn.oaistatic.com/_next/static/chunks/main-app.js"></script>
                </head>
                </html>
            `;
            const [sources, dataBuild] = parsePowResources(sampleHtml);
            expect(sources.length).toBe(2);
            expect(sources[0]).toContain('sentinel/sdk.js');
            expect(dataBuild).toBe('c/2026-08-24-12345/_');
        });

        it('should fallback to default PoW script if HTML is empty', () => {
            const [sources, dataBuild] = parsePowResources('');
            expect(sources).toEqual([DEFAULT_POW_SCRIPT]);
            expect(dataBuild).toBe('');
        });

        it('should construct valid PoW config structure with required length and types', () => {
            const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
            const config = buildPowConfig(userAgent, [DEFAULT_POW_SCRIPT], 'build-123');

            expect(Array.isArray(config)).toBe(true);
            expect(config.length).toBe(25);
            expect(typeof config[0]).toBe('number'); // screen res sum
            expect(typeof config[1]).toBe('string'); // legacy parse time
            expect(config[4]).toBe(userAgent);
            expect(config[6]).toBe('build-123');
        });

        it('should solve PoW challenge for target difficulty (SHA3-512)', () => {
            const seed = 'test-seed-xyz-123';
            // 容易的 difficulty (如 'ff', 几乎第一次尝试即满足 <= 0xff)
            const difficulty = 'ff';
            const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
            const config = buildPowConfig(userAgent, [DEFAULT_POW_SCRIPT], '');

            const [answer, solved] = powGenerate(seed, difficulty, config, 1000);
            expect(solved).toBe(true);
            expect(typeof answer).toBe('string');
            expect(answer.length).toBeGreaterThan(0);

            // 验证 SHA3-512 结果是否满足 <= difficulty
            const seedBytes = Buffer.from(seed, 'utf8');
            const answerBytes = Buffer.from(answer, 'utf8');
            const digest = crypto.createHash('sha3-512')
                .update(Buffer.concat([seedBytes, answerBytes]))
                .digest();

            const target = Buffer.from(difficulty, 'hex');
            expect(Buffer.compare(digest.subarray(0, 1), target)).toBeLessThanOrEqual(0);
        });

        it('should build valid gAAAAAC legacy requirements token', () => {
            const token = buildLegacyRequirementsToken('Mozilla/5.0');
            expect(token.startsWith('gAAAAAC')).toBe(true);
            const base64Part = token.slice(7);
            const decoded = JSON.parse(Buffer.from(base64Part, 'base64').toString('utf8'));
            expect(Array.isArray(decoded)).toBe(true);
            expect(decoded.length).toBe(25);
        });

        it('should build valid gAAAAAB proof token for feasible difficulty', () => {
            const token = buildProofToken('seed-123', 'ff', 'Mozilla/5.0');
            expect(token.startsWith('gAAAAAB')).toBe(true);
        });
    });

    describe('2. Turnstile Virtual Machine Solver', () => {
        it('should return null for empty or invalid input', () => {
            expect(solveTurnstileToken(null, null)).toBeNull();
            expect(solveTurnstileToken('', '')).toBeNull();
            expect(solveTurnstileToken('invalid-base64-!@#$', 'key')).toBeNull();
        });

        it('should correctly execute bytecode operations and return base64 result', () => {
            const key = 'secret-key';
            const bytecode = [
                [2, 'reg1', 'test_data'],
                [3, 'hello_turnstile']
            ];
            const jsonStr = JSON.stringify(bytecode);
            // XOR with key
            let xorStr = '';
            for (let i = 0; i < jsonStr.length; i++) {
                xorStr += String.fromCharCode(jsonStr.charCodeAt(i) ^ key.charCodeAt(i % key.length));
            }
            const dx = Buffer.from(xorStr, 'utf8').toString('base64');

            const result = solveTurnstileToken(dx, key);
            expect(result).toBe(Buffer.from('hello_turnstile', 'utf8').toString('base64'));
        });
    });

    describe('3. Token & Quota Service', () => {
        it('should decode JWT payload correctly', () => {
            const payload = { sub: 'user_123', email: 'test@example.com', exp: Math.floor(Date.now() / 1000) + 3600 };
            const fakeJwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64')}.sig`;

            const decoded = decodeJwtPayload(fakeJwt);
            expect(decoded.email).toBe('test@example.com');
            expect(decoded.sub).toBe('user_123');
        });

        it('should detect expiring or expired JWTs', () => {
            const now = Math.floor(Date.now() / 1000);
            const expiredPayload = { exp: now - 100 };
            const expiredJwt = `header.${Buffer.from(JSON.stringify(expiredPayload)).toString('base64')}.sig`;
            expect(isJwtExpiredOrNear(expiredJwt, 3600)).toBe(true);

            const nearPayload = { exp: now + 1800 }; // 30 mins remaining
            const nearJwt = `header.${Buffer.from(JSON.stringify(nearPayload)).toString('base64')}.sig`;
            expect(isJwtExpiredOrNear(nearJwt, 3600)).toBe(true);

            const freshPayload = { exp: now + 86400 * 2 }; // 2 days
            const freshJwt = `header.${Buffer.from(JSON.stringify(freshPayload)).toString('base64')}.sig`;
            expect(isJwtExpiredOrNear(freshJwt, 3600)).toBe(false);
        });

        it('should extract quota and restoreAt from limits_progress', () => {
            const limits = [
                { feature_name: 'code_interpreter', remaining: 100 },
                { feature_name: 'image_gen', remaining: 4, reset_after: '2026-08-24T18:00:00Z' }
            ];
            const [quota, restoreAt] = extractQuotaAndRestoreAt(limits);
            expect(quota).toBe(4);
            expect(restoreAt).toBe('2026-08-24T18:00:00Z');
        });
    });

    describe('4. Image File Decoding & Dimension Analysis', () => {
        it('should decode base64 strings and Data URIs', () => {
            const rawB64 = 'SGVsbG8gV29ybGQ=';
            const buf1 = decodeImageBase64(rawB64);
            expect(buf1.toString('utf8')).toBe('Hello World');

            const dataUri = 'data:image/png;base64,SGVsbG8gV29ybGQ=';
            const buf2 = decodeImageBase64(dataUri);
            expect(buf2.toString('utf8')).toBe('Hello World');
        });

        it('should detect PNG dimensions and mime type', () => {
            // PNG header (8 bytes) + IHDR chunk (4 len, 4 type "IHDR", 4 width=800, 4 height=600)
            const pngBuffer = Buffer.alloc(32);
            // PNG signature
            pngBuffer.set([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A], 0);
            // IHDR chunk
            pngBuffer.writeUInt32BE(800, 16);
            pngBuffer.writeUInt32BE(600, 20);

            expect(getImageMimeType(pngBuffer)).toBe('image/png');
            const dims = getImageDimensions(pngBuffer);
            expect(dims.width).toBe(800);
            expect(dims.height).toBe(600);
        });

        it('should detect JPEG header and mime type', () => {
            const jpegBuffer = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
            expect(getImageMimeType(jpegBuffer)).toBe('image/jpeg');
        });
    });

    describe('5. ChatGPT Web Service & Adapter', () => {
        it('should instantiate ChatGPTWebService with model list and config', async () => {
            const service = new ChatGPTWebService({
                access_token: 'fake-token',
                email: 'user@example.com',
                quota: 10
            });

            expect(service.email).toBe('user@example.com');
            expect(service.quota).toBe(10);

            const models = await service.listModels();
            expect(models.data.some(m => m.id === 'gpt-image-2')).toBe(true);
            expect(models.data.some(m => m.id === 'gpt-5')).toBe(true);
        });

        it('should handle ImageContentPolicyError properly', () => {
            const err = new ImageContentPolicyError('抱歉，该提示违反了内容政策', 'conv_123');
            expect(err.name).toBe('ImageContentPolicyError');
            expect(err.isPolicyError).toBe(true);
            expect(err.conversationId).toBe('conv_123');
        });
    });

    describe('6. Constants, Protocols & Converters Registry', () => {
        it('should have CHATGPT_WEB registered in MODEL_PROVIDER and MODEL_PROTOCOL_PREFIX', () => {
            expect(MODEL_PROVIDER.CHATGPT_WEB).toBe('chatgpt-web');
            expect(MODEL_PROTOCOL_PREFIX.CHATGPT).toBe('chatgpt');
        });

        it('should map chatgpt-web to chatgpt protocol in getProtocolPrefix', () => {
            expect(getProtocolPrefix('chatgpt-web')).toBe('chatgpt');
            expect(getProtocolPrefix('chatgpt-web-custom')).toBe('chatgpt');
        });

        it('should resolve converter for CHATGPT protocol via ConverterFactory', () => {
            const converter = ConverterFactory.getConverter(MODEL_PROTOCOL_PREFIX.CHATGPT);
            expect(converter).toBeDefined();
            expect(typeof converter.convertRequest).toBe('function');
        });
    });
});
