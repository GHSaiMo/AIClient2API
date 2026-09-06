import { describe, it, expect, jest } from '@jest/globals';
import { handleGetProviders, handleGetProviderType } from '../../src/ui-modules/provider-api.js';

describe('Grok Web & Image Generation Usage Counting Suite', () => {

    describe('1. In-memory Provider Status Precedence over Stale Disk Cache', () => {
        it('should preserve in-memory usageCount in handleGetProviders even if disk has older data', async () => {
            const mockProviderPoolManager = {
                providerStatus: {
                    'grok-web': [
                        {
                            config: {
                                uuid: 'grok-uuid-1',
                                email: 'test@grok.com',
                                usageCount: 42,
                                errorCount: 0,
                                isHealthy: true
                            },
                            state: { activeCount: 0, waitingCount: 0 }
                        }
                    ]
                }
            };

            const currentConfig = {
                PROVIDER_POOLS_FILE_PATH: 'non_existent_pools_file.json'
            };

            const req = {};
            let responseData = null;
            const res = {
                writeHead: jest.fn(),
                end: jest.fn((str) => {
                    responseData = JSON.parse(str);
                })
            };

            await handleGetProviders(req, res, currentConfig, mockProviderPoolManager);

            expect(responseData).not.toBeNull();
            expect(responseData.providers['grok-web']).toBeDefined();
            expect(responseData.providers['grok-web'][0].usageCount).toBe(42);
        });

        it('should return live in-memory provider status in handleGetProviderType', async () => {
            const mockProviderPoolManager = {
                providerStatus: {
                    'grok-web': [
                        {
                            config: {
                                uuid: 'grok-uuid-1',
                                email: 'test@grok.com',
                                usageCount: 15,
                                errorCount: 0,
                                isHealthy: true
                            },
                            state: { activeCount: 1, waitingCount: 0 }
                        }
                    ]
                }
            };

            const currentConfig = {
                PROVIDER_POOLS_FILE_PATH: 'non_existent_pools_file.json'
            };

            const req = {};
            let responseData = null;
            const res = {
                writeHead: jest.fn(),
                end: jest.fn((str) => {
                    responseData = JSON.parse(str);
                })
            };

            await handleGetProviderType(req, res, currentConfig, mockProviderPoolManager, 'grok-web');

            expect(responseData).not.toBeNull();
            expect(responseData.providerType).toBe('grok-web');
            expect(responseData.totalCount).toBe(1);
            expect(responseData.providers[0].usageCount).toBe(15);
            expect(responseData.providers[0].activeRequests).toBe(1);
        });
    });

    describe('2. Provider Pool markProviderHealthy usageCount increment', () => {
        it('should correctly increment usageCount when markProviderHealthy is called', async () => {
            const { ProviderPoolManager } = await import('../../src/providers/provider-pool-manager.js');
            const initialPools = {
                'grok-web': [
                    {
                        uuid: 'grok-node-1',
                        email: 'user@grok.com',
                        usageCount: 0,
                        isHealthy: true
                    }
                ]
            };

            const poolManager = new ProviderPoolManager(initialPools, { logLevel: 'error' });
            expect(poolManager.providerStatus['grok-web'][0].config.usageCount).toBe(0);

            // Simulate what handleImageGenerationRequest / handleImageEditsRequest calls on success
            poolManager.markProviderHealthy('grok-web', { uuid: 'grok-node-1' });

            expect(poolManager.providerStatus['grok-web'][0].config.usageCount).toBe(1);
            expect(poolManager.providerStatus['grok-web'][0].config.isHealthy).toBe(true);

            poolManager.markProviderHealthy('grok-web', { uuid: 'grok-node-1' });
            expect(poolManager.providerStatus['grok-web'][0].config.usageCount).toBe(2);
        });
    });
});
