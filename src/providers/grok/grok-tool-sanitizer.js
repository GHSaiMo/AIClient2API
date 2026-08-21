/**
 * Grok / xAI 工具净化与防挂起处理器 (Grok Tool Sanitizer)
 * 
 * 借鉴 CLIProxyAPI (xai_executor.go) 机制：
 * 1. 复杂 Schema 挂起防护：
 *    第三方客户端（如 Codex Desktop）注入的 `codex_app.automation_update` 或带有大量 `oneOf + $ref` 的 Schema，
 *    xAI 上游 Responses 路径虽然接受 HTTP 请求，但由于解析器缺陷会永远停在 "thinking" 不产生 SSE 输出。
 *    该模块自动识别并替换为安全兼容的占位 Schema，彻底消除客户端 Hang 死问题。
 * 2. 内部 x_search 噪声过滤：
 *    过滤服务端内部搜索产生的子工具追踪数据，保证输出纯净。
 */

import logger from '../../utils/logger.js';

export const SAFE_FUNCTION_PARAMETERS = {
    type: 'object',
    properties: {},
    additionalProperties: true
};

/**
 * 识别已知会导致 xAI 上游死锁/挂起的危险工具
 * @param {string} toolName 
 * @param {Object} schema 
 * @returns {boolean}
 */
export function isProblematicGrokToolSchema(toolName, schema) {
    const name = String(toolName || '').toLowerCase();
    
    // 已知问题工具名称
    if (name.includes('automation_update') || name.includes('codex_app')) {
        return true;
    }

    // 检查是否包含极其复杂的 oneOf + $ref 结构导致上游解析器死循环
    if (schema && typeof schema === 'object') {
        const str = JSON.stringify(schema);
        if (str.includes('"$ref"') && str.includes('"oneOf"') && str.length > 3000) {
            return true;
        }
    }

    return false;
}

/**
 * 清洗传入 Grok 的工具定义列表
 * @param {Array<Object>} tools - 工具定义数组
 * @returns {Array<Object>} 清洗后的工具数组
 */
export function sanitizeGrokTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return tools;

    return tools.map(tool => {
        if (!tool || typeof tool !== 'object') return tool;

        const isFunction = tool.type === 'function' || Boolean(tool.function);
        const func = tool.function || tool;
        const name = func.name || tool.name;
        const parameters = func.parameters || func.input_schema;

        if (isProblematicGrokToolSchema(name, parameters)) {
            logger.warn(`[Grok Tool Sanitizer] Detected hazardous tool schema for '${name}', replacing with safe placeholder schema to prevent upstream hang`);
            
            if (tool.function) {
                return {
                    ...tool,
                    function: {
                        ...tool.function,
                        parameters: SAFE_FUNCTION_PARAMETERS
                    }
                };
            }

            return {
                ...tool,
                parameters: SAFE_FUNCTION_PARAMETERS
            };
        }

        return tool;
    });
}

/**
 * 过滤 xAI Responses 内部 x_search 的冗余跟踪数据
 * @param {Object|string} eventData - SSE 数据包
 * @returns {Object|null} 过滤后的数据包，如果是纯内部噪声则返回 null
 */
export function filterInternalXSearchOutput(eventData) {
    if (!eventData) return eventData;

    try {
        const data = typeof eventData === 'string' ? JSON.parse(eventData) : eventData;
        
        // 如果是内部 subtool 追踪事件（如 x_search 的 internal queries），进行过滤
        if (data.type === 'response.output_item.added' || data.type === 'response.output_item.done') {
            const item = data.item;
            if (item && (item.type === 'internal_x_search_trace' || item.name === 'internal_search_query')) {
                logger.debug('[Grok Tool Sanitizer] Filtered internal x_search trace output item');
                return null;
            }
        }

        return data;
    } catch (e) {
        return eventData;
    }
}
