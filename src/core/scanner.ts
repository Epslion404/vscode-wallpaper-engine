import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PlayableWallpaperType, WallpaperType } from './types';
import { SceneSource } from './scene-cache';

export type WallpaperDiagnosticCategory = 'corrupted' | 'unsupported' | 'permissionDenied';

export interface WallpaperDiagnostic {
    category: WallpaperDiagnosticCategory;
    wallpaperId: string;
    path: string;
    message: string;
    cause?: unknown;
}

export interface WallpaperScanStatistics {
    totalDirectories: number;
    available: number;
    corrupted: number;
    unsupported: number;
    permissionDenied: number;
}

export interface WallpaperScanResult {
    items: WallpaperItem[];
    statistics: WallpaperScanStatistics;
    diagnostics: WallpaperDiagnostic[];
}

export type WallpaperDiagnosticLogger = (diagnostic: WallpaperDiagnostic) => void;

interface WallpaperInfo {
    type: WallpaperType;
    file: string;
    location: string;
}

interface ParsedProject {
    json: Record<string, unknown>;
}

interface ResolveFailure {
    category: WallpaperDiagnosticCategory;
    message: string;
    cause?: unknown;
}

type ResolveResult =
    | { info: WallpaperInfo; project: ParsedProject }
    | { failure: ResolveFailure };

// WallpaperItem 同时承载 QuickPick 展示信息和服务器所需的媒体位置。
export class WallpaperItem implements vscode.QuickPickItem {
    label: string;
    description: string;
    detail: string;
    dirPath: string;
    type: WallpaperType;
    id: string;
    location: string;
    projectJsonPath: string;

    constructor(title: string, id: string, file: string, dirPath: string, type: WallpaperType, location?: string) {
        this.label = `$(device-camera-video) ${title}`;
        this.description = `ID: ${id} [${type}]`;
        this.detail = file;
        this.dirPath = dirPath;
        this.type = type;
        this.id = id;
        this.location = location || dirPath;
        this.projectJsonPath = path.join(dirPath, 'project.json');
    }

    getMediaPath(): { path: string, type: PlayableWallpaperType } {
        if (this.type === WallpaperType.Scene) {
            // 禁止 Scene 绕过录制准备流程进入注入器。
            throw new Error('Scene 壁纸必须先录制为视频缓存');
        }
        const mainFile = this.detail || 'index.html';
        let finalPath = path.join(this.location, mainFile);

        // 图片项目可能把真实壁纸放在 preview.jpg，而非 project.json 的 file 字段中。
        if (this.type === WallpaperType.Image && !mainFile.match(/\.(jpg|jpeg|png)$/i)) {
            const preview = path.join(this.location, 'preview.jpg');
            if (fs.existsSync(preview)) {
                finalPath = preview;
            }
        }
        return { path: finalPath, type: this.type };
    }

    getSceneSource(): SceneSource {
        if (this.type !== WallpaperType.Scene) {
            throw new Error('当前壁纸不是 Scene 类型');
        }
        const sourceRoot = path.resolve(this.location);
        const realSourceRoot = fs.realpathSync.native(sourceRoot);
        const candidates = [
            path.resolve(sourceRoot, this.detail),
            path.resolve(sourceRoot, 'scene.pkg')
        ];
        const sourcePath = candidates.find(candidate => {
            if (!isInside(sourceRoot, candidate)) {
                return false;
            }
            try {
                return isInside(realSourceRoot, fs.realpathSync.native(candidate));
            } catch {
                return false;
            }
        });
        if (!sourcePath) {
            throw new Error('Scene 入口资源不存在或超出壁纸目录');
        }
        return {
            wallpaperId: this.id,
            projectJsonPath: this.projectJsonPath,
            sourcePath
        };
    }
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

function isPermissionError(value: unknown): boolean {
    const code = (value as NodeJS.ErrnoException | undefined)?.code;
    return code === 'EACCES' || code === 'EPERM';
}

function failureFromFs(error: unknown, fallbackMessage: string): ResolveFailure {
    return {
        category: isPermissionError(error) ? 'permissionDenied' : 'corrupted',
        message: isPermissionError(error) ? `${fallbackMessage}（无权限）` : fallbackMessage,
        cause: asError(error)
    };
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function parseProject(dirPath: string, wallpaperId: string): ParsedProject | { failure: ResolveFailure } {
    const projectJsonPath = path.join(dirPath, 'project.json');
    let projectStat: fs.Stats;
    try {
        projectStat = fs.statSync(projectJsonPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
            return { failure: { category: 'corrupted', message: '缺少 project.json' } };
        }
        return { failure: failureFromFs(error, `无法读取 ${wallpaperId} 的 project.json`) };
    }

    if (!projectStat.isFile()) {
        return { failure: { category: 'corrupted', message: 'project.json 不是文件' } };
    }

    let rawContent: string;
    try {
        rawContent = fs.readFileSync(projectJsonPath, 'utf8');
    } catch (error) {
        return { failure: failureFromFs(error, `无法读取 ${projectJsonPath}`) };
    }

    try {
        const value: unknown = JSON.parse(rawContent);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return { failure: { category: 'corrupted', message: 'project.json 必须是对象' } };
        }
        return { json: value as Record<string, unknown> };
    } catch (error) {
        return { failure: { category: 'corrupted', message: `无法解析 ${projectJsonPath}`, cause: asError(error) } };
    }
}

function resolveWallpaperInfo(
    workshopPath: string,
    id: string,
    visited = new Set<string>()
): ResolveResult {
    if (typeof id !== 'string' || !id) {
        return { failure: { category: 'corrupted', message: '壁纸 ID 无效' } };
    }

    const workshopRoot = path.resolve(workshopPath);
    const dirPath = path.resolve(workshopRoot, id);
    if (!isInside(workshopRoot, dirPath)) {
        return { failure: { category: 'corrupted', message: '壁纸路径超出工坊目录范围' } };
    }

    let realWorkshopRoot: string;
    let realDirPath: string;
    try {
        realWorkshopRoot = fs.realpathSync.native(workshopRoot);
        realDirPath = fs.realpathSync.native(dirPath);
    } catch (error) {
        return { failure: failureFromFs(error, '无法访问壁纸目录') };
    }
    if (!isInside(realWorkshopRoot, realDirPath)) {
        return { failure: { category: 'corrupted', message: '壁纸符号链接超出工坊目录范围' } };
    }

    if (visited.has(id)) {
        return { failure: { category: 'corrupted', message: '壁纸依赖存在循环引用' } };
    }
    visited.add(id);

    const parsed = parseProject(dirPath, id);
    if ('failure' in parsed) {
        return parsed;
    }

    const rawType = typeof parsed.json.type === 'string' ? parsed.json.type.toLowerCase() : '';
    const type = rawType === 'video'
        ? WallpaperType.Video
        : rawType === 'image'
            ? WallpaperType.Image
            : rawType === 'web'
                ? WallpaperType.Web
                : rawType === 'scene'
                    ? WallpaperType.Scene
                    : null;
    const file = typeof parsed.json.file === 'string' && parsed.json.file ? parsed.json.file : undefined;

    if (type) {
        return { info: { type, file: file || 'index.html', location: dirPath }, project: parsed };
    }

    if (parsed.json.dependency !== undefined) {
        if (typeof parsed.json.dependency !== 'string' || !parsed.json.dependency) {
            return { failure: { category: 'corrupted', message: 'dependency 必须是非空字符串' } };
        }
        const dependency = resolveWallpaperInfo(workshopPath, parsed.json.dependency, visited);
        if ('failure' in dependency) {
            return {
                failure: {
                    ...dependency.failure,
                    message: `依赖 ${parsed.json.dependency} 无法加载：${dependency.failure.message}`
                }
            };
        }
        return {
            info: {
                type: dependency.info.type,
                file: file || dependency.info.file,
                location: dependency.info.location
            },
            project: parsed
        };
    }

    return {
        failure: {
            category: rawType ? 'unsupported' : 'corrupted',
            message: rawType ? `不支持的壁纸类型：${rawType}` : 'project.json 缺少 type'
        }
    };
}

function createDiagnostic(workshopPath: string, wallpaperId: string, failure: ResolveFailure): WallpaperDiagnostic {
    return {
        category: failure.category,
        wallpaperId,
        path: path.join(workshopPath, wallpaperId),
        message: failure.message,
        cause: failure.cause
    };
}

function emptyStatistics(): WallpaperScanStatistics {
    return { totalDirectories: 0, available: 0, corrupted: 0, unsupported: 0, permissionDenied: 0 };
}

export function scanWallpapersWithDiagnostics(workshopPath: string, logger?: WallpaperDiagnosticLogger): WallpaperScanResult {
    const result: WallpaperScanResult = { items: [], statistics: emptyStatistics(), diagnostics: [] };
    const emit = (diagnostic: WallpaperDiagnostic): void => {
        result.diagnostics.push(diagnostic);
        result.statistics[diagnostic.category] += 1;
        console.warn(`[Scanner] ${diagnostic.wallpaperId || workshopPath}: ${diagnostic.message}`);
        logger?.(diagnostic);
    };

    let entries: string[];
    try {
        entries = fs.readdirSync(workshopPath);
    } catch (error) {
        emit({
            category: isPermissionError(error) ? 'permissionDenied' : 'corrupted',
            wallpaperId: '',
            path: workshopPath,
            message: isPermissionError(error) ? '无法读取工坊目录（无权限）' : '无法读取工坊目录',
            cause: asError(error)
        });
        return result;
    }

    for (const id of entries) {
        const dirPath = path.join(workshopPath, id);
        try {
            if (!fs.statSync(dirPath).isDirectory()) {
                continue;
            }
        } catch (error) {
            emit({
                category: isPermissionError(error) ? 'permissionDenied' : 'corrupted',
                wallpaperId: id,
                path: dirPath,
                message: isPermissionError(error) ? '无法访问壁纸目录（无权限）' : '无法检查壁纸目录',
                cause: asError(error)
            });
            continue;
        }

        result.statistics.totalDirectories += 1;
        const resolved = resolveWallpaperInfo(workshopPath, id);
        if ('failure' in resolved) {
            emit(createDiagnostic(workshopPath, id, resolved.failure));
            continue;
        }

        const title = typeof resolved.project.json.title === 'string' && resolved.project.json.title
            ? resolved.project.json.title
            : '未命名';
        result.items.push(new WallpaperItem(
            title,
            id,
            resolved.info.file,
            dirPath,
            resolved.info.type,
            resolved.info.location
        ));
        result.statistics.available += 1;
    }

    return result;
}

export function scanWallpapers(workshopPath: string): WallpaperItem[] {
    return scanWallpapersWithDiagnostics(workshopPath).items;
}

export function getWallpaperById(workshopPath: string, id: string): WallpaperItem | null {
    const resolved = resolveWallpaperInfo(workshopPath, id);
    if ('failure' in resolved) {
        console.warn(`[Scanner] ${id}: ${resolved.failure.message}`);
        return null;
    }
    const dirPath = path.join(workshopPath, id);
    const title = typeof resolved.project.json.title === 'string' && resolved.project.json.title
        ? resolved.project.json.title
        : '未命名';
    return new WallpaperItem(title, id, resolved.info.file, dirPath, resolved.info.type, resolved.info.location);
}
