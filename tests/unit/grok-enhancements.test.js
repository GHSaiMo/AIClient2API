import { describe, it, expect, beforeEach } from '@jest/globals';
import { grokReasoningCache } from '../../src/providers/grok/grok-reasoning-cache.js';
import {
    isProblematicGrokToolSchema,
    sanitizeGrokTools,
    filterInternalXSearchOutput,
    SAFE_FUNCTION_PARAMETERS
} from '../../src/providers/grok/grok-tool-sanitizer.js';
import { SUPPORTED_IMAGE_MODELS } from '../../src/utils/constants.js';
import { getProviderModels } from '../../src/providers/provider-models.js';
import { GrokApiService } from '../../src/providers/grok/grok-core.js';
import { GrokCliApiService } from '../../src/providers/grok/grok-cli-core.js';
import '../../src/converters/register-converters.js';

describe('Phase 2: Grok Reasoning Replay & Tool Governance Suite', () => {

    describe('1. Grok Reasoning Replay Cache (grok-reasoning-cache.js)', () => {
        beforeEach(() => {
            grokReasoningCache.cache.clear();
        });

        it('should build isolated scoped keys for different callers and models', () => {
            const key1 = grokReasoningCache.buildScopedKey('caller_a', 'session_1', 'grok-3');
            const key2 = grokReasoningCache.buildScopedKey('caller_b', 'session_1', 'grok-3');
            const key3 = grokReasoningCache.buildScopedKey('caller_a', 'session_1', 'grok-4.20');

            expect(key1).not.toBe(key2);
            expect(key1).not.toBe(key3);
            expect(key1).toContain('grok-3');
            expect(key1).toContain('session_1');
        });

        it('should generate stable session key from conversation messages', () => {
            const messages1 = [{ role: 'user', content: 'Help me write a Python script' }];
            const messages2 = [{ role: 'user', content: 'Help me write a Python script' }];
            const messages3 = [{ role: 'user', content: 'Different topic' }];

            const key1 = grokReasoningCache.generateSessionKeyFromMessages(messages1);
            const key2 = grokReasoningCache.generateSessionKeyFromMessages(messages2);
            const key3 = grokReasoningCache.generateSessionKeyFromMessages(messages3);

            expect(key1).toBe(key2);
            expect(key1).not.toBe(key3);
        });

        it('should cache and retrieve reasoning items correctly', () => {
            const scopedKey = 'caller1:grok-3:sess123';
            const reasoningItems = [
                { type: 'reasoning', encrypted_content: 'enc_data_xyz', summary: 'thinking...' }
            ];

            grokReasoningCache.set(scopedKey, reasoningItems);
            const retrieved = grokReasoningCache.get(scopedKey);

            expect(retrieved).not.toBeNull();
            expect(retrieved.length).toBe(1);
            expect(retrieved[0].encrypted_content).toBe('enc_data_xyz');
        });

        it('should inject cached reasoning items into input when input lacks reasoning', () => {
            const scopedKey = 'caller1:grok-3:sess123';
            const reasoningItems = [
                { type: 'reasoning', encrypted_content: 'enc_data_xyz' }
            ];
            grokReasoningCache.set(scopedKey, reasoningItems);

            const inputItems = [
                { role: 'user', content: 'Step 1' },
                { role: 'assistant', content: 'Response 1' },
                { role: 'user', content: 'Step 2' }
            ];

            const updatedInput = grokReasoningCache.applyReplayToInput(inputItems, scopedKey);
            expect(updatedInput.length).toBe(4);
            expect(updatedInput[1].type).toBe('reasoning');
            expect(updatedInput[1].encrypted_content).toBe('enc_data_xyz');
            expect(updatedInput[2].role).toBe('assistant');
        });

        it('should not duplicate reasoning items if input already has reasoning', () => {
            const scopedKey = 'caller1:grok-3:sess123';
            grokReasoningCache.set(scopedKey, [{ type: 'reasoning', encrypted_content: 'enc_new' }]);

            const inputItems = [
                { type: 'reasoning', encrypted_content: 'enc_existing' },
                { role: 'user', content: 'Step 1' }
            ];

            const updatedInput = grokReasoningCache.applyReplayToInput(inputItems, scopedKey);
            expect(updatedInput.length).toBe(2);
            expect(updatedInput[0].encrypted_content).toBe('enc_existing');
        });
    });

    describe('2. Grok Tool Sanitizer & Hang Mitigation (grok-tool-sanitizer.js)', () => {
        it('should identify problematic tools like automation_update or codex_app', () => {
            expect(isProblematicGrokToolSchema('codex_app.automation_update', {})).toBe(true);
            expect(isProblematicGrokToolSchema('automation_update', {})).toBe(true);
            expect(isProblematicGrokToolSchema('readFile', { type: 'object' })).toBe(false);
        });

        it('should replace problematic tool schemas with safe placeholder schema', () => {
            const tools = [
                {
                    type: 'function',
                    function: {
                        name: 'codex_app.automation_update',
                        description: 'Codex app automation',
                        parameters: {
                            type: 'object',
                            oneOf: [{ $ref: '#/definitions/complex' }]
                        }
                    }
                },
                {
                    type: 'function',
                    function: {
                        name: 'runTerminalCommand',
                        description: 'Run command in shell',
                        parameters: {
                            type: 'object',
                            properties: { command: { type: 'string' } }
                        }
                    }
                }
            ];

            const sanitized = sanitizeGrokTools(tools);

            // Problematic tool schema should be replaced
            expect(sanitized[0].function.parameters).toEqual(SAFE_FUNCTION_PARAMETERS);
            // Normal tool should be unchanged
            expect(sanitized[1].function.parameters.properties.command.type).toBe('string');
        });

        it('should filter internal x_search trace events from stream output', () => {
            const normalEvent = {
                type: 'response.output_item.added',
                item: { type: 'message', content: 'Search results here' }
            };
            const internalTraceEvent = {
                type: 'response.output_item.added',
                item: { type: 'internal_x_search_trace', query: 'telemetry query' }
            };

            expect(filterInternalXSearchOutput(normalEvent)).toEqual(normalEvent);
            expect(filterInternalXSearchOutput(internalTraceEvent)).toBeNull();
        });
    });

    describe('3. Grok Imagine 2.0 Model Integration Suite', () => {
        it('should include grok-imagine-image-2.0 in SUPPORTED_IMAGE_MODELS', () => {
            expect(SUPPORTED_IMAGE_MODELS.has('grok-imagine-image-2.0')).toBe(true);
            expect(SUPPORTED_IMAGE_MODELS.has('grok-imagine-image-pro')).toBe(true);
            expect(SUPPORTED_IMAGE_MODELS.has('grok-imagine-image')).toBe(true);
            expect(SUPPORTED_IMAGE_MODELS.has('grok-imagine-image-lite')).toBe(true);
            expect(SUPPORTED_IMAGE_MODELS.has('grok-imagine-image-edit')).toBe(true);
        });

        it('should include grok-imagine-image-2.0 in grok-web provider models', () => {
            const webModels = getProviderModels('grok-web');
            expect(webModels).toContain('grok-imagine-image-2.0');
            expect(webModels).toContain('grok-imagine-image-pro');
            expect(webModels).toContain('grok-imagine-image');
            expect(webModels).toContain('grok-imagine-image-lite');
            expect(webModels).toContain('grok-imagine-image-edit');
        });

        it('should include grok-imagine-image-2.0 in grok-cli-oauth provider models', () => {
            const cliModels = getProviderModels('grok-cli-oauth');
            expect(cliModels).toContain('grok-imagine-image-2.0');
        });

        it('should correctly map grok-imagine-image-2.0 in GrokApiService with isPro: true', () => {
            const service = new GrokApiService({ GROK_COOKIE_TOKEN: 'test' });
            const mapping = service._getModelMapping('grok-imagine-image-2.0');
            expect(mapping).toBeDefined();
            expect(mapping.isPro).toBe(true);
        });

        it('should correctly prepare image request body with quality in GrokCliApiService', () => {
            const cliService = new GrokCliApiService({
                access_token: 'test_token',
                refresh_token: 'test_refresh'
            });
            const request = {
                prompt: 'A cute futuristic robot',
                quality: 'medium',
                aspect_ratio: '16:9',
                resolution: '2k'
            };
            const { endpointPath, body } = cliService.prepareImageRequestBody('grok-imagine-image-2.0', request);
            expect(endpointPath).toBe('/images/generations');
            expect(body.model).toBe('grok-imagine-image-2.0');
            expect(body.prompt).toBe('A cute futuristic robot');
            expect(body.quality).toBe('medium');
            expect(body.aspect_ratio).toBe('16:9');
            expect(body.resolution).toBe('2k');
        });

        it('should break early in _generateAndCollectWS when requested n images are collected', async () => {
            const service = new GrokApiService({ GROK_COOKIE_TOKEN: 'test_token' });
            let streamCalls = 0;

            // Mock stream generator that would keep yielding forever if not broken
            async function* mockStream() {
                streamCalls++;
                yield { type: 'image', id: 'img-1', url: 'https://assets.grok.com/img1.jpg', blob: 'base64data1', percentage_complete: 100, stage: 'final' };
                streamCalls++;
                yield { type: 'image', id: 'img-2', url: 'https://assets.grok.com/img2.jpg', blob: 'base64data2', percentage_complete: 100, stage: 'final' };
                streamCalls++;
                yield { type: 'image', id: 'img-3', url: 'https://assets.grok.com/img3.jpg', blob: 'base64data3', percentage_complete: 100, stage: 'final' };
            }

            const mockWsService = {
                stream: jest.fn().mockImplementation(() => mockStream())
            };

            const originalCreatePost = service.createPost;
            service.createPost = jest.fn().mockResolvedValue(null);

            // Temporarily replace ImagineWebSocketService
            const { ImagineWebSocketService } = await import('../../src/providers/grok/ws-imagine.js');
            const streamSpy = jest.spyOn(ImagineWebSocketService.prototype, 'stream').mockImplementation(() => mockStream());

            const result = await service._generateAndCollectWS('grok-imagine-image-2.0', { n: 1, message: 'test prompt' });
            expect(result.cardAttachments.length).toBe(1);
            const cardData = JSON.parse(result.cardAttachments[0].jsonData);
            expect(cardData.image.original).toBe('https://assets.grok.com/img1.jpg');
            expect(cardData.image.blob).toBe('base64data1');
            // Stream should have stopped after the first image
            expect(streamCalls).toBe(1);

            streamSpy.mockRestore();
            service.createPost = originalCreatePost;
        });

        it('should break early in _generateContentStreamWS when requested n images are yielded', async () => {
            const service = new GrokApiService({ GROK_COOKIE_TOKEN: 'test_token' });
            let streamCalls = 0;

            async function* mockStream() {
                streamCalls++;
                yield { type: 'image', id: 'img-1', url: 'https://assets.grok.com/img1.jpg', blob: 'base64data1', percentage_complete: 100, stage: 'final' };
                streamCalls++;
                yield { type: 'image', id: 'img-2', url: 'https://assets.grok.com/img2.jpg', blob: 'base64data2', percentage_complete: 100, stage: 'final' };
            }

            const { ImagineWebSocketService } = await import('../../src/providers/grok/ws-imagine.js');
            const streamSpy = jest.spyOn(ImagineWebSocketService.prototype, 'stream').mockImplementation(() => mockStream());

            const generator = service._generateContentStreamWS('grok-imagine-image-2.0', { n: 1, message: 'test prompt' });
            const yieldedItems = [];
            for await (const item of generator) {
                yieldedItems.push(item);
            }

            // Should have yielded progress, cardAttachment and done response
            const cardItem = yieldedItems.find(i => i.result?.response?.cardAttachment);
            expect(cardItem).toBeDefined();
            const cardData = JSON.parse(cardItem.result.response.cardAttachment.jsonData);
            expect(cardData.image.blob).toBe('base64data1');
            expect(streamCalls).toBe(1);

            streamSpy.mockRestore();
        });
    });

    describe('4. Circular Structure Error & Auth Failure Classification Suite', () => {
        it('isQuotaExhaustedError should handle circular stream objects without throwing TypeError', async () => {
            const { isQuotaExhaustedError } = await import('../../src/utils/common.js');

            // 构造类似 IncomingMessage 的循环引用对象
            const circularStream = {
                on: () => {},
                read: () => {},
                statusCode: 401
            };
            circularStream.req = { stream: circularStream };

            const error = new Error('401 Unauthorized (stream): Failed to look up session ID.');
            error.response = {
                status: 401,
                data: circularStream
            };

            expect(() => {
                const isQuota = isQuotaExhaustedError(error);
                expect(isQuota).toBe(false);
            }).not.toThrow();
        });

        it('GrokApiService classifyApiError should identify 401 and invalid credentials as definitive auth failures', async () => {
            const service = new GrokApiService({ GROK_COOKIE_TOKEN: 'test_token' });
            const circularStream = { on: () => {}, read: () => {} };
            circularStream.self = circularStream;

            const error = new Error('401 Unauthorized (stream): Failed to look up session ID. [WKE=unauthenticated:invalid-credentials]');
            error.response = {
                status: 401,
                data: circularStream
            };

            const result = await service.classifyApiError(error);
            expect(result.status).toBe(401);
            expect(result.isDefinitiveAuthFailure).toBe(true);
            expect(error.isDefinitiveAuthFailure).toBe(true);
            expect(error.shouldSwitchCredential).toBe(true);
        });
    });
});

