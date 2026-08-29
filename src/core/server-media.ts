import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

export interface MediaRange {
    start: number;
    end: number;
}

export interface CurrentMediaOptions {
    rootPath: string;
    location?: string;
    entryFile: string | null;
}

const MEDIA_MIME_TYPES: Readonly<Record<string, string>> = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml'
};

/**
 * 解析浏览器媒体请求使用的单段字节范围。多段和畸形范围均拒绝，
 * 避免意外扩大响应范围或引入 multipart 响应分支。
 */
export function parseSingleByteRange(header: string, size: number): MediaRange | undefined {
    if (!Number.isSafeInteger(size) || size <= 0) {
        return undefined;
    }
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match || (match[1] === '' && match[2] === '')) {
        return undefined;
    }

    if (match[1] === '') {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
            return undefined;
        }
        return {
            start: Math.max(size - suffixLength, 0),
            end: size - 1
        };
    }

    const start = Number(match[1]);
    const requestedEnd = match[2] === '' ? size - 1 : Number(match[2]);
    if (!Number.isSafeInteger(start)
        || !Number.isSafeInteger(requestedEnd)
        || start < 0
        || requestedEnd < start
        || start >= size) {
        return undefined;
    }
    return { start, end: Math.min(requestedEnd, size - 1) };
}

function isWithinRoot(realRoot: string, realCandidate: string): boolean {
    const relative = path.relative(realRoot, realCandidate);
    return relative === ''
        || (relative !== '..'
            && !relative.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relative));
}

async function resolveCurrentMedia(options: CurrentMediaOptions): Promise<{ filePath: string; size: number; mimeType: string } | undefined> {
    if (!options.entryFile) {
        return undefined;
    }
    const mimeType = MEDIA_MIME_TYPES[path.extname(options.entryFile).toLowerCase()];
    if (!mimeType) {
        return undefined;
    }

    const roots = [...new Set([options.rootPath, options.location].filter((item): item is string => Boolean(item)))];
    for (const root of roots) {
        try {
            const realRoot = await fs.promises.realpath(root);
            const candidate = path.resolve(root, options.entryFile);
            const realCandidate = await fs.promises.realpath(candidate);
            if (!isWithinRoot(realRoot, realCandidate)) {
                continue;
            }
            const stat = await fs.promises.stat(realCandidate);
            if (stat.isFile()) {
                return { filePath: realCandidate, size: stat.size, mimeType };
            }
        } catch {
            // 候选缺失或无权读取时按 404 处理，避免外部请求通过日志探测本机路径。
        }
    }
    return undefined;
}

function setMediaHeaders(
    response: http.ServerResponse,
    media: { size: number; mimeType: string },
    contentLength: number
): void {
    response.setHeader('Content-Type', media.mimeType);
    response.setHeader('Content-Length', contentLength);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
}

function setSafetyHeaders(response: http.ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
}

/** 固定服务当前播放条目，不读取 URL 参数，也不允许越过当前根目录。 */
export async function serveCurrentMedia(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    options: CurrentMediaOptions
): Promise<void> {
    setSafetyHeaders(response);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.statusCode = 405;
        response.setHeader('Allow', 'GET, HEAD');
        response.end('Method Not Allowed');
        return;
    }

    const media = await resolveCurrentMedia(options);
    if (!media) {
        response.statusCode = 404;
        response.end('Current media not found');
        return;
    }

    const rangeHeader = request.headers.range;
    const range = rangeHeader === undefined ? undefined : parseSingleByteRange(rangeHeader, media.size);
    if (rangeHeader !== undefined && !range) {
        response.statusCode = 416;
        response.setHeader('Content-Range', `bytes */${media.size}`);
        setMediaHeaders(response, media, 0);
        response.end();
        return;
    }

    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(media.size - 1, 0);
    const contentLength = media.size === 0 ? 0 : end - start + 1;
    response.statusCode = range ? 206 : 200;
    setMediaHeaders(response, media, contentLength);
    if (range) {
        response.setHeader('Content-Range', `bytes ${start}-${end}/${media.size}`);
    }
    if (request.method === 'HEAD' || media.size === 0) {
        response.end();
        return;
    }

    const stream = fs.createReadStream(media.filePath, { start, end });
    const disposeStream = (): void => {
        if (!stream.destroyed) {
            stream.destroy();
        }
    };
    request.once('aborted', disposeStream);
    response.once('close', () => {
        if (!response.writableEnded) {
            disposeStream();
        }
    });
    stream.once('error', error => {
        console.error(`[Media] 当前媒体流读取失败：${error.name}`);
        if (!response.headersSent) {
            response.statusCode = 500;
            response.end('Media stream failed');
            return;
        }
        response.destroy(error);
    });
    stream.pipe(response);
}
