import { describe, it, expect } from '@jest/globals';
import {
    estimatePayloadTokensAndMedia,
    computeDynamicTimeout,
    applyDynamicTimeout,
    DYNAMIC_TIMEOUT_BASE_MS,
    DYNAMIC_TIMEOUT_MIN_MS,
    DYNAMIC_TIMEOUT_MAX_MS,
    DYNAMIC_STREAM_IDLE_TIMEOUT_MS
} from '../../src/utils/dynamic-timeout.js';

describe('Universal Dynamic Adaptive Timeout Suite', () => {

    describe('1. Universal Payload Estimator (Multi-Provider Support)', () => {
        it('should handle null/empty body gracefully', () => {
            const res = estimatePayloadTokensAndMedia(null);
            expect(res.estimatedTokens).toBe(0);
            expect(res.mediaCount).toBe(0);
            expect(res.hasThinking).toBe(false);
        });

        it('should correctly estimate OpenAI format (messages + tools + reasoning_effort)', () => {
            const body = {
                model: 'o3-mini',
                reasoning_effort: 'high',
                messages: [
                    { role: 'system', content: 'You are a helpful assistant.'.repeat(10) },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Analyze this photo'.repeat(20) },
                            { type: 'image_url', image_url: { url: 'https://example.com/a.jpg' } }
                        ]
                    }
                ],
                tools: [
                    {
                        type: 'function',
                        function: { name: 'search', description: 'Web search' }
                    }
                ]
            };

            const res = estimatePayloadTokensAndMedia(body);
            expect(res.estimatedTokens).toBeGreaterThan(100);
            expect(res.mediaCount).toBe(1);
            expect(res.hasThinking).toBe(true);
        });

        it('should correctly estimate Claude format (system + messages + thinking + images)', () => {
            const body = {
                model: 'claude-3-7-sonnet-20250219',
                system: 'You are Claude, a helpful AI.'.repeat(15),
                thinking: {
                    type: 'enabled',
                    budget_tokens: 4096
                },
                messages: [
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Examine these documents' },
                            { type: 'image', source: { type: 'base64', data: 'abc' } },
                            { type: 'document', source: { type: 'base64', data: 'def' } }
                        ]
                    }
                ]
            };

            const res = estimatePayloadTokensAndMedia(body);
            expect(res.estimatedTokens).toBeGreaterThan(50);
            expect(res.mediaCount).toBe(2);
            expect(res.hasThinking).toBe(true);
        });

        it('should correctly estimate Codex responses format (instructions + input)', () => {
            const body = {
                model: 'gpt-5.5',
                instructions: 'Follow these rules carefully.'.repeat(20),
                input: [
                    {
                        type: 'message',
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Generate code for this task'.repeat(50) }
                        ]
                    }
                ]
            };

            const res = estimatePayloadTokensAndMedia(body);
            expect(res.estimatedTokens).toBeGreaterThan(300);
            expect(res.mediaCount).toBe(0);
        });

        it('should detect thinking models across various providers by naming pattern', () => {
            const models = [
                'deepseek-reasoner',
                'deepseek-r1',
                'o1-preview',
                'o3-mini',
                'qwq-32b-preview',
                'gemini-3.8-flash-thinking',
                'grok-3-reasoning',
                'grok-3-deepsearch'
            ];

            for (const model of models) {
                const res = estimatePayloadTokensAndMedia({
                    model,
                    messages: [{ role: 'user', content: 'test' }]
                });
                expect(res.hasThinking).toBe(true);
            }
        });
    });

    describe('2. computeDynamicTimeout Scaling Tiers & Guard Limits', () => {
        it('should return base 60s for standard short turns (< 15k tokens)', () => {
            const body = {
                model: 'gpt-4o',
                messages: [{ role: 'user', content: 'Hello there' }]
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(timeoutMs).toBe(60000);
            expect(details.contextBonusMs).toBe(0);
            expect(details.mediaBonusMs).toBe(0);
            expect(details.hasThinking).toBe(false);
        });

        it('should scale to 90s for medium context (15k - 50k tokens)', () => {
            // ~20k tokens -> ~76,000 characters
            const body = {
                model: 'gpt-4o',
                messages: [{ role: 'user', content: 'a'.repeat(76000) }]
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(timeoutMs).toBe(90000);
            expect(details.contextBonusMs).toBe(30000);
        });

        it('should scale to 150s for heavy context (50k - 100k tokens)', () => {
            // ~60k tokens -> ~228,000 characters
            const body = {
                model: 'claude-3-5-sonnet',
                messages: [{ role: 'user', content: 'a'.repeat(228000) }]
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(timeoutMs).toBe(150000);
            expect(details.contextBonusMs).toBe(90000);
        });

        it('should scale to 240s for ultra-long context (>= 100k tokens)', () => {
            // ~110k tokens -> ~418,000 characters
            const body = {
                model: 'gemini-2.5-pro',
                messages: [{ role: 'user', content: 'a'.repeat(418000) }]
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(timeoutMs).toBe(240000);
            expect(details.contextBonusMs).toBe(180000);
        });

        it('should add media bonus (+10s per item, capped at +60s)', () => {
            const body = {
                model: 'gpt-4o',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'Look at these 3 photos' },
                        { type: 'image_url', image_url: { url: '1.jpg' } },
                        { type: 'image_url', image_url: { url: '2.jpg' } },
                        { type: 'image_url', image_url: { url: '3.jpg' } }
                    ]
                }]
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(details.mediaBonusMs).toBe(30000);
            expect(timeoutMs).toBe(90000);
        });

        it('should floor thinking models at 120s minimum', () => {
            const body = {
                model: 'o3-mini',
                messages: [{ role: 'user', content: 'Short math puzzle' }]
            };
            const { timeoutMs, details } = computeDynamicTimeout(body);
            expect(details.hasThinking).toBe(true);
            expect(timeoutMs).toBe(120000);
        });

        it('should clamp to maxTimeoutMs (300s ceiling)', () => {
            const body = {
                model: 'deepseek-reasoner',
                messages: [
                    { role: 'user', content: 'a'.repeat(500000) },
                    {
                        role: 'user',
                        content: Array(10).fill({ type: 'image_url', image_url: { url: 'x.jpg' } })
                    }
                ]
            };
            const { timeoutMs } = computeDynamicTimeout(body);
            expect(timeoutMs).toBe(300000);
        });
    });

    describe('3. applyDynamicTimeout helper', () => {
        it('should set reqOptions.timeout and attach details', () => {
            const reqOptions = { method: 'POST', url: '/v1/chat' };
            const body = {
                model: 'o1',
                messages: [{ role: 'user', content: 'Hi' }]
            };

            const result = applyDynamicTimeout(reqOptions, body, { logPrefix: '[Test Guard]' });
            expect(reqOptions.timeout).toBe(120000);
            expect(reqOptions._dynamicTimeoutDetails.hasThinking).toBe(true);
            expect(result.timeoutMs).toBe(120000);
        });
    });
});
