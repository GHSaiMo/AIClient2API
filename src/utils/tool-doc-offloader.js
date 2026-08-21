/**
 * 工具超长描述转写工具 (Tool Description Offloader)
 * 
 * 借鉴 kiro-gateway 机制：
 * AWS CodeWhisperer/Kiro 等接口对 toolSpecification.description 长度有严格上限（超长直接报 400）。
 * 当工具描述超长时，将完整文档剥离追加到 System Prompt 中，
 * 在工具定义处保留引用标记，既避免 400 报错，又 100% 保留工具的完整指令上下文。
 */

export const DEFAULT_TOOL_DESCRIPTION_MAX_LENGTH = 400;

/**
 * 处理工具列表中的超长描述
 * @param {Array} tools - 工具列表 (Kiro 格式或标准 OpenAI/Claude 格式)
 * @param {Object} options - 配置选项
 * @param {number} [options.maxLength=400] - 允许的最大描述长度
 * @returns {{ processedTools: Array, toolDocumentation: string }} 处理后的工具列表与需追加至系统提示词的文档
 */
export function processToolsWithLongDescriptions(tools, options = {}) {
    if (!Array.isArray(tools) || tools.length === 0) {
        return { processedTools: tools || [], toolDocumentation: '' };
    }

    const maxLength = typeof options.maxLength === 'number' && options.maxLength > 0 
        ? options.maxLength 
        : DEFAULT_TOOL_DESCRIPTION_MAX_LENGTH;

    const docSections = [];
    const processedTools = [];

    for (const tool of tools) {
        if (!tool || typeof tool !== 'object') {
            processedTools.push(tool);
            continue;
        }

        // 识别 Kiro 格式 (tool.toolSpecification) 与标准格式 (tool.function / tool.name)
        const isKiroFormat = Boolean(tool.toolSpecification);
        const spec = isKiroFormat ? tool.toolSpecification : (tool.function || tool);
        const toolName = spec.name || tool.name || 'unnamed_tool';
        const description = spec.description || '';

        if (typeof description === 'string' && description.length > maxLength) {
            // 超长：提取完整描述到 system prompt 文档区
            docSections.push(`## Tool: ${toolName}\n\n${description}`);
            
            const shortReference = `[Full documentation in system prompt under '## Tool: ${toolName}']`;

            if (isKiroFormat) {
                processedTools.push({
                    ...tool,
                    toolSpecification: {
                        ...spec,
                        description: shortReference
                    }
                });
            } else if (tool.function) {
                processedTools.push({
                    ...tool,
                    function: {
                        ...tool.function,
                        description: shortReference
                    }
                });
            } else {
                processedTools.push({
                    ...tool,
                    description: shortReference
                });
            }
        } else {
            processedTools.push(tool);
        }
    }

    const toolDocumentation = docSections.length > 0 
        ? `\n\n# Extended Tool Documentation\n${docSections.join('\n\n')}`
        : '';

    return { processedTools, toolDocumentation };
}
