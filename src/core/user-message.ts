const DEFAULT_REASON = '发生未知错误，请重试。';
const DEFAULT_MAX_LENGTH = 160;

function readErrorCode(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return undefined;
    }
    const code = error.code;
    return typeof code === 'string' ? code : undefined;
}

function readErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return '';
}

function stripAbsolutePaths(message: string): string {
    let sanitized = message
        .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"'<>|]+/g, '相关路径')
        .replace(/\/(?:[^\s"'<>|]+\/)+[^\s"'<>|]*/g, '相关路径');

    if (sanitized !== message && !sanitized.includes('相关路径')) {
        sanitized += '（相关路径）';
    }
    return sanitized;
}

function stripControlCharacters(message: string): string {
    return message
        .replace(/\u001B\[[0-?]*[ -\/]*[@-~]/g, '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim();
}

/** 清除诊断文本中的本机路径和控制字符；保留其余上下文供日志排查。 */
export function redactLocalDetails(message: string): string {
    return stripControlCharacters(stripAbsolutePaths(message));
}

function limitLength(message: string, maxLength: number): string {
    if (message.length <= maxLength) {
        return message;
    }
    const limit = Math.max(1, maxLength - 1);
    return `${Array.from(message).slice(0, limit).join('')}…`;
}

/** 将底层异常转换为可展示给用户的简短中文原因；详细异常应继续写入日志。 */
export function toUserErrorReason(error: unknown, maxLength = DEFAULT_MAX_LENGTH): string {
    const normalizedMaxLength = Number.isFinite(maxLength) && maxLength > 0
        ? Math.floor(maxLength)
        : DEFAULT_MAX_LENGTH;
    const code = readErrorCode(error);
    const knownReasons: Record<string, string> = {
        EACCES: '权限不足，无法访问所需文件。',
        EPERM: '权限不足，无法完成文件操作。',
        ENOENT: '所需文件不存在或已被移动。',
        EADDRINUSE: '本地服务端口已被占用。',
        ETIMEDOUT: '操作超时，请检查服务状态后重试。',
        ECONNREFUSED: '本地服务连接被拒绝，请重试。',
    };
    const knownReason = code ? knownReasons[code] : undefined;
    if (knownReason) {
        return limitLength(knownReason, normalizedMaxLength);
    }

    const message = redactLocalDetails(readErrorMessage(error));
    if (!message) {
        return DEFAULT_REASON;
    }
    return limitLength(message, normalizedMaxLength);
}
