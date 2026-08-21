/**
 * JSON Schema 递归净化工具
 * 
 * 用于消除 AWS CodeWhisperer / Kiro 等严格 API 不支持的 JSON Schema 关键字和格式，
 * 防止客户端（如 Cline, Claude Code, Cursor 等）发送的复杂 schema 触发 400 错误。
 */

/**
 * 递归清洗 JSON Schema，剔除上游不支持的字段
 * @param {Object|null|undefined} schema - 原始 JSON Schema
 * @returns {Object} 清洗后的 JSON Schema
 */
export function sanitizeJsonSchema(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema ?? {};
    }

    if (Array.isArray(schema)) {
        return schema.map(item => sanitizeJsonSchema(item));
    }

    const sanitized = {};

    for (const [key, value] of Object.entries(schema)) {
        // 1. 过滤空的 required 数组（Kiro 遇到 required: [] 会报 400）
        if (key === 'required' && Array.isArray(value)) {
            const nonEmptyRequired = value.filter(field => typeof field === 'string' && field.trim().length > 0);
            if (nonEmptyRequired.length > 0) {
                sanitized.required = nonEmptyRequired;
            }
            continue;
        }

        // 2. 移除 additionalProperties（Kiro API 规范不支持该关键字）
        if (key === 'additionalProperties') {
            continue;
        }

        // 3. 递归清洗 properties 对象
        if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
            const sanitizedProps = {};
            for (const [propName, propSchema] of Object.entries(value)) {
                // 剔除空属性名
                if (!propName || propName.trim() === '') continue;
                sanitizedProps[propName] = sanitizeJsonSchema(propSchema);
            }
            sanitized.properties = sanitizedProps;
            continue;
        }

        // 4. 递归清洗 items（数组项 schema）
        if (key === 'items') {
            if (Array.isArray(value)) {
                sanitized.items = value.map(item => sanitizeJsonSchema(item));
            } else if (value && typeof value === 'object') {
                sanitized.items = sanitizeJsonSchema(value);
            } else {
                sanitized.items = value;
            }
            continue;
        }

        // 5. 递归清洗 anyOf / oneOf / allOf
        if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(value)) {
            const cleanedList = value.map(item => sanitizeJsonSchema(item));
            if (cleanedList.length > 0) {
                sanitized[key] = cleanedList;
            }
            continue;
        }

        // 6. 递归清洗 $defs 和 definitions
        if (['$defs', 'definitions'].includes(key) && value && typeof value === 'object' && !Array.isArray(value)) {
            const sanitizedDefs = {};
            for (const [defName, defSchema] of Object.entries(value)) {
                sanitizedDefs[defName] = sanitizeJsonSchema(defSchema);
            }
            sanitized[key] = sanitizedDefs;
            continue;
        }

        // 7. 处理嵌套对象或数组
        if (value && typeof value === 'object') {
            sanitized[key] = sanitizeJsonSchema(value);
        } else {
            sanitized[key] = value;
        }
    }

    return sanitized;
}

/**
 * 递归清洗整个 Tool Specification 中的 inputSchema
 * @param {Object} toolSpec - Kiro/CodeWhisperer 格式的 toolSpecification
 * @returns {Object} 清洗后的 toolSpecification
 */
export function sanitizeToolSpecification(toolSpec) {
    if (!toolSpec || typeof toolSpec !== 'object') return toolSpec;

    const copy = { ...toolSpec };
    if (copy.inputSchema && typeof copy.inputSchema === 'object') {
        const schemaContainer = copy.inputSchema;
        if (schemaContainer.json && typeof schemaContainer.json === 'object') {
            copy.inputSchema = {
                ...schemaContainer,
                json: sanitizeJsonSchema(schemaContainer.json)
            };
        } else {
            copy.inputSchema = sanitizeJsonSchema(schemaContainer);
        }
    }

    return copy;
}
