import { describe, it, expect } from '@jest/globals';
import { extractKiroPromptRemaining, ProviderPoolManager } from '../../src/providers/provider-pool-manager.js';

describe('Phase 3.2: Account Pool Quota Smart Ranking Suite', () => {

    describe('1. Kiro Pure Prompt Quota Extraction (extractKiroPromptRemaining)', () => {
        it('should calculate remaining prompt credits correctly without bonus interference', () => {
            const accountConfig = {
                credits_total: 1000,
                credits_used: 350,
                bonus_total: 500, // Should be ignored
                bonus_used: 100   // Should be ignored
            };

            const remaining = extractKiroPromptRemaining(accountConfig);
            expect(remaining).toBe(650); // 1000 - 350
        });

        it('should support camelCase properties', () => {
            const accountConfig = {
                creditsTotal: 500,
                creditsUsed: 120
            };

            const remaining = extractKiroPromptRemaining(accountConfig);
            expect(remaining).toBe(380);
        });

        it('should support nested usage object', () => {
            const accountConfig = {
                usage: {
                    credits_total: 200,
                    credits_used: 50
                }
            };

            const remaining = extractKiroPromptRemaining(accountConfig);
            expect(remaining).toBe(150);
        });

        it('should floor at 0 when usage exceeds total', () => {
            const accountConfig = {
                credits_total: 100,
                credits_used: 150
            };

            const remaining = extractKiroPromptRemaining(accountConfig);
            expect(remaining).toBe(0);
        });

        it('should return null when quota information is absent', () => {
            expect(extractKiroPromptRemaining(null)).toBeNull();
            expect(extractKiroPromptRemaining({})).toBeNull();
            expect(extractKiroPromptRemaining({ apiKey: 'sk-123' })).toBeNull();
        });
    });

    describe('3. Node Scoring & Error Suppression (_calculateNodeScore)', () => {
        it('should suppress isFresh negative bias and penalize nodes with errors', () => {
            const poolManager = Object.create(ProviderPoolManager.prototype);
            poolManager.providerStatus = {};

            const now = Date.now();
            const freshFailedNode = {
                type: 'grok-web',
                uuid: 'uuid-fail',
                config: {
                    uuid: 'uuid-fail',
                    isHealthy: true,
                    errorCount: 1,
                    lastErrorTime: new Date(now - 1000).toISOString(),
                    lastHealthCheckTime: new Date(now - 500).toISOString(), // refreshed just now
                    lastUsed: new Date(now - 10000).toISOString(),
                    usageCount: 5
                },
                state: { activeCount: 0, waitingCount: 0 }
            };

            const normalHealthyNode = {
                type: 'grok-web',
                uuid: 'uuid-healthy',
                config: {
                    uuid: 'uuid-healthy',
                    isHealthy: true,
                    errorCount: 0,
                    lastErrorTime: null,
                    lastHealthCheckTime: new Date(now - 120000).toISOString(),
                    lastUsed: new Date(now - 20000).toISOString(),
                    usageCount: 5
                },
                state: { activeCount: 0, waitingCount: 0 }
            };

            const scoreFailed = poolManager._calculateNodeScore(freshFailedNode, now);
            const scoreHealthy = poolManager._calculateNodeScore(normalHealthyNode, now);

            // Healthy node must have a much lower score (higher priority) than the failed node
            expect(scoreHealthy).toBeLessThan(scoreFailed);
            expect(scoreFailed).toBeGreaterThan(1e12); // Has error penalty
        });
    });

    describe('4. excludeUuids Option in Provider Selection', () => {
        it('should exclude specified UUIDs during provider selection', () => {
            const poolManager = Object.create(ProviderPoolManager.prototype);
            poolManager._checkAndRecoverScheduledProviders = () => {};
            poolManager._calculateNodeScore = (p) => p.config.score || 0;
            poolManager._debouncedSave = () => {};
            poolManager._log = () => {};
            poolManager._getDisplayName = (c) => c.uuid;
            poolManager._selectionSequence = 0;

            const node1 = { uuid: 'uuid-1', config: { uuid: 'uuid-1', isHealthy: true, score: 10 } };
            const node2 = { uuid: 'uuid-2', config: { uuid: 'uuid-2', isHealthy: true, score: 20 } };
            const node3 = { uuid: 'uuid-3', config: { uuid: 'uuid-3', isHealthy: true, score: 30 } };

            poolManager.providerStatus = {
                'grok-web': [node1, node2, node3]
            };

            // Without excludeUuids, node1 (lowest score) is selected
            const selectedDefault = poolManager._doSelectProvider('grok-web', null, {});
            expect(selectedDefault.uuid).toBe('uuid-1');

            // With excludeUuids = ['uuid-1'], node2 is selected
            const selectedExclude1 = poolManager._doSelectProvider('grok-web', null, { excludeUuids: ['uuid-1'] });
            expect(selectedExclude1.uuid).toBe('uuid-2');

            // With excludeUuids = ['uuid-1', 'uuid-2'], node3 is selected
            const selectedExclude12 = poolManager._doSelectProvider('grok-web', null, { excludeUuids: new Set(['uuid-1', 'uuid-2']) });
            expect(selectedExclude12.uuid).toBe('uuid-3');
        });
    });
});
