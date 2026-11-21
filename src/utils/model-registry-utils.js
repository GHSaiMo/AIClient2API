import logger from './logger.js';
import { MODEL_PROTOCOL_PREFIX, MODEL_PROVIDER } from './constants.js';
import { ENDPOINT_TYPE, getProtocolPrefix } from './protocol-utils.js';
import { handleError } from './retry-error-utils.js';
import { convertData } from '../convert/convert.js';
import { getEstimatedModelContextLength } from '../handlers/probe-handler.js';
import {
    usesManagedModelList,
    getConfiguredSupportedModels,
    getCustomModelConfig,
    getCustomModelActualProvider,
    getCustomModelListProvider
} from '../providers/provider-models.js';

function getConfiguredSupportedModelsFromPool(providerPoolManager, providerType) {
    if (!providerPoolManager?.providerStatus?.[providerType]) {
        return [];
    }

    return [...new Set(
        providerPoolManager.providerStatus[providerType]
            .flatMap(providerStatus => getConfiguredSupportedModels(providerType, providerStatus.config))
    )].sort((a, b) => a.localeCompare(b));
}

function getCustomModelEntriesForProvider(config, providerType = null, options = {}) {
    const customModels = Array.isArray(config?.customModels) ? config.customModels : [];
    const entries = [];

    customModels.forEach(modelConfig => {
        if (!modelConfig?.id) {
            return;
        }

        const modelProvider = getCustomModelListProvider(modelConfig);
        const actualProvider = getCustomModelActualProvider(modelConfig);
        const isMatch = !providerType ||
            modelProvider === providerType ||
            (modelProvider && providerType.startsWith(modelProvider + '-'));

        if (!isMatch) {
            return;
        }

        const modelId = modelConfig.id;
        if (!modelId) {
            return;
        }

        const responseId = options.prefixProvider && modelProvider
            ? `${modelProvider}:${modelId}`
            : modelId;

        entries.push({
            id: responseId,
            modelId,
            provider: modelProvider || providerType || MODEL_PROVIDER.AUTO,
            actualProvider: actualProvider || modelProvider || providerType || MODEL_PROVIDER.AUTO,
            config: modelConfig
        });
    });

    return entries;
}

export function resolveCustomModelRouting(model, currentProvider, customModelConfig = getCustomModelConfig(model, currentProvider)) {
    if (!customModelConfig) {
        return {
            isCustomModel: false,
            model,
            provider: currentProvider,
            actualModel: model,
            actualProvider: currentProvider,
            config: null
        };
    }

    const customActualProvider = getCustomModelActualProvider(customModelConfig);
    const customActualModel = customModelConfig.actualModel || customModelConfig.id || model;

    return {
        isCustomModel: true,
        model: customActualModel,
        provider: customActualProvider || currentProvider,
        actualModel: customActualModel,
        actualProvider: customActualProvider || currentProvider,
        config: customModelConfig
    };
}

function appendCustomModelsToModelList(clientModelList, customEntries, providerType, listEndpointType) {
    const entries = Array.isArray(customEntries) ? customEntries : [];
    const hasMetadataValue = (value) => value !== undefined && value !== null;

    if (!entries.length) {
        return clientModelList;
    }

    if (listEndpointType === ENDPOINT_TYPE.GEMINI_MODEL_LIST) {
        const models = Array.isArray(clientModelList?.models) ? clientModelList.models : [];

        entries.forEach(entry => {
            const existingModel = models.find(model => {
                const existingId = model?.baseModelId || model?.name;
                if (!existingId) return false;
                const normalizedId = existingId.startsWith('models/') ? existingId.substring(7) : existingId;
                return normalizedId === entry.id;
            });
            if (existingModel) {
                existingModel.displayName = entry.config.name || existingModel.displayName || entry.id;
                existingModel.description = entry.config.description || existingModel.description || `Model ${entry.modelId} provided by ${entry.provider || providerType}`;
                if (hasMetadataValue(entry.config.contextLength)) existingModel.inputTokenLimit = entry.config.contextLength;
                if (hasMetadataValue(entry.config.maxTokens)) existingModel.outputTokenLimit = entry.config.maxTokens;
                return;
            }

            const modelResponse = {
                name: `models/${entry.id}`,
                baseModelId: entry.id,
                version: 'v1',
                displayName: entry.config.name || entry.id,
                description: entry.config.description || `Model ${entry.modelId} provided by ${entry.provider || providerType}`,
                supportedGenerationMethods: ['generateContent', 'countTokens']
            };

            if (hasMetadataValue(entry.config.contextLength)) modelResponse.inputTokenLimit = entry.config.contextLength;
            if (hasMetadataValue(entry.config.maxTokens)) modelResponse.outputTokenLimit = entry.config.maxTokens;

            models.push(modelResponse);
        });

        return {
            ...clientModelList,
            models
        };
    }

    if (listEndpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
        const models = Array.isArray(clientModelList?.data) ? clientModelList.data : [];

        entries.forEach(entry => {
            const existingModel = models.find(model => model?.id === entry.id);
            if (existingModel) {
                if (entry.config.name) existingModel.display_name = entry.config.name;
                if (entry.config.description) existingModel.description = entry.config.description;
                if (hasMetadataValue(entry.config.contextLength)) existingModel.context_length = entry.config.contextLength;
                if (hasMetadataValue(entry.config.maxTokens)) existingModel.max_tokens = entry.config.maxTokens;
                return;
            }

            const modelResponse = {
                id: entry.id,
                object: 'model',
                created: Math.floor(Date.now() / 1000),
                owned_by: entry.provider || providerType || 'custom',
                display_name: entry.config.name || entry.id
            };

            if (entry.config.description) modelResponse.description = entry.config.description;
            if (hasMetadataValue(entry.config.contextLength)) modelResponse.context_length = entry.config.contextLength;
            if (hasMetadataValue(entry.config.maxTokens)) modelResponse.max_tokens = entry.config.maxTokens;

            models.push(modelResponse);
        });

        return {
            ...clientModelList,
            object: 'list',
            data: models
        };
    }

    return clientModelList;
}

export async function handleModelListRequest(req, res, service, endpointType, CONFIG, providerPoolManager, pooluuid) {
    const clientProviderMap = {
        [ENDPOINT_TYPE.OPENAI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.OPENAI,
        [ENDPOINT_TYPE.GEMINI_MODEL_LIST]: MODEL_PROTOCOL_PREFIX.GEMINI,
    };

    const fromProvider = clientProviderMap[endpointType];

    try {
        if (!fromProvider) {
            throw new Error(`Unsupported endpoint type for model list: ${endpointType}`);
        }

        let clientModelList;

        const buildConfiguredModelListResponse = (models, providerType, listEndpointType) => {
            if (listEndpointType === ENDPOINT_TYPE.OPENAI_MODEL_LIST) {
                return {
                    object: 'list',
                    data: models.map(modelId => {
                        const customConfig = getCustomModelConfig(modelId, providerType);
                        const modelResponse = {
                            id: modelId,
                            object: 'model',
                            created: Math.floor(Date.now() / 1000),
                            owned_by: providerType
                        };

                        if (customConfig) {
                            if (customConfig.contextLength) modelResponse.context_length = customConfig.contextLength;
                            if (customConfig.maxTokens) modelResponse.max_tokens = customConfig.maxTokens;
                            if (customConfig.description) modelResponse.description = customConfig.description;
                        }

                        return modelResponse;
                    })
                };
            }

            if (listEndpointType === ENDPOINT_TYPE.GEMINI_MODEL_LIST) {
                return {
                    models: models.map(modelId => {
                        const customConfig = getCustomModelConfig(modelId, providerType);
                        const modelResponse = {
                            name: `models/${modelId}`,
                            baseModelId: modelId,
                            version: 'v1',
                            displayName: modelId,
                            description: `Model ${modelId} provided by ${providerType}`,
                            supportedGenerationMethods: ['generateContent', 'countTokens']
                        };

                        if (customConfig) {
                            if (customConfig.contextLength) modelResponse.inputTokenLimit = customConfig.contextLength;
                            if (customConfig.maxTokens) modelResponse.outputTokenLimit = customConfig.maxTokens;
                            if (customConfig.description) modelResponse.description = customConfig.description;
                        }

                        return modelResponse;
                    })
                };
            }

            return { data: [] };
        };

        if (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO && providerPoolManager) {
            logger.info(`[ModelList] Aggregating models for 'auto' mode...`);
            clientModelList = await providerPoolManager.getAllAvailableModels(endpointType);
        } else {
            const toProvider = CONFIG.MODEL_PROVIDER;
            const pooledSupportedModels = getConfiguredSupportedModelsFromPool(providerPoolManager, toProvider);
            const configuredSupportedModels = pooledSupportedModels.length > 0
                ? pooledSupportedModels
                : getConfiguredSupportedModels(toProvider, CONFIG);

            if (usesManagedModelList(toProvider) && configuredSupportedModels.length > 0) {
                logger.info(`[ModelList] Returning configured supported models for ${toProvider}: ${configuredSupportedModels.join(', ')}`);
                clientModelList = buildConfiguredModelListResponse(configuredSupportedModels, toProvider, endpointType);
            } else {
                let resolvedService = service;
                if (!resolvedService) {
                    const { getApiService } = await import('../services/service-manager.js');
                    resolvedService = await getApiService(CONFIG, null, { skipUsageCount: true });
                }

                if (!resolvedService || typeof resolvedService.listModels !== 'function') {
                    throw new Error(`[ModelList] Service adapter is unavailable or does not implement listModels() for provider: ${toProvider}`);
                }

                const nativeModelList = await resolvedService.listModels();

                clientModelList = nativeModelList;
                if (!getProtocolPrefix(toProvider).includes(getProtocolPrefix(fromProvider))) {
                    logger.info(`[ModelList Convert] Converting model list from ${toProvider} to ${fromProvider}`);
                    clientModelList = convertData(nativeModelList, 'modelList', toProvider, fromProvider);
                } else {
                    logger.info(`[ModelList Convert] Model list format matches. No conversion needed.`);
                }
            }

            const customEntries = getCustomModelEntriesForProvider(CONFIG, toProvider);
            clientModelList = appendCustomModelsToModelList(clientModelList, customEntries, toProvider, endpointType);
        }

        if (CONFIG.MODEL_PROVIDER === MODEL_PROVIDER.AUTO) {
            const customEntries = getCustomModelEntriesForProvider(CONFIG, null, { prefixProvider: true });
            clientModelList = appendCustomModelsToModelList(clientModelList, customEntries, MODEL_PROVIDER.AUTO, endpointType);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(clientModelList));
    } catch (error) {
        logger.error('\n[Server] Error during model list processing:', error.stack);
        handleError(res, error, CONFIG.MODEL_PROVIDER, fromProvider);
    }
}

export async function handleModelDetailRequest(req, res, path, CONFIG, providerPoolManager) {
    try {
        const modelId = path.replace(/^\/(?:api\/)?v1\/models\//, '');
        const provider = CONFIG?.MODEL_PROVIDER || MODEL_PROVIDER.KIRO_API;
        const ctx = getEstimatedModelContextLength(modelId, provider);
        const customConfig = getCustomModelConfig(modelId, provider);

        const modelResponse = {
            id: modelId,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: provider || 'system',
            context_length: ctx,
            max_input_tokens: ctx,
            max_tokens: 65536
        };

        if (customConfig) {
            if (customConfig.contextLength) {
                modelResponse.context_length = customConfig.contextLength;
                modelResponse.max_input_tokens = customConfig.contextLength;
            }
            if (customConfig.maxTokens) modelResponse.max_tokens = customConfig.maxTokens;
            if (customConfig.description) modelResponse.description = customConfig.description;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(modelResponse));
    } catch (error) {
        logger.error('[Server] Error during model detail processing:', error.stack);
        handleError(res, error, CONFIG?.MODEL_PROVIDER, MODEL_PROTOCOL_PREFIX.OPENAI);
    }
}
