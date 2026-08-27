import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';

export function isPrivateAddress(address: string): boolean {
    const normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
    if (net.isIPv4(normalized)) {
        const octets = normalized.split('.').map(Number);
        const [a, b] = octets;
        return a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 ||
            (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && (b === 0 || b === 2 || b === 168)) ||
            (a === 198 && (b === 18 || b === 19 || b === 51)) ||
            (a === 203 && b === 0) || a >= 224;
    }
    if (net.isIPv6(normalized)) {
        if (normalized.startsWith('::ffff:')) {
            return isPrivateAddress(normalized.slice(7));
        }
        return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
            normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
            normalized.startsWith('fea') || normalized.startsWith('feb');
    }
    return true;
}

export function validateProxyTarget(raw: string): URL {
    const target = new URL(raw);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('Only http and https proxy targets are allowed');
    }
    if (!target.hostname) {
        throw new Error('Proxy target hostname is required');
    }
    if (net.isIP(target.hostname) && isPrivateAddress(target.hostname)) {
        throw new Error('Private proxy targets are not allowed');
    }
    return target;
}

export function assertPublicAddress(address: string): void {
    if (isPrivateAddress(address)) {
        throw new Error('Private proxy targets are not allowed');
    }
}

export function isPathWithinRealRoot(rootPath: string, candidatePath: string): boolean {
    try {
        const root = fs.realpathSync(rootPath);
        const candidate = fs.realpathSync(candidatePath);
        const relative = path.relative(root, candidate);
        return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    } catch {
        return false;
    }
}

export function isFileWithinRealRoot(rootPath: string, candidatePath: string): boolean {
    try {
        return isPathWithinRealRoot(rootPath, candidatePath) && fs.statSync(candidatePath).isFile();
    } catch {
        return false;
    }
}

export function isDirectoryWithinRealRoot(rootPath: string, candidatePath: string): boolean {
    try {
        return isPathWithinRealRoot(rootPath, candidatePath) && fs.statSync(candidatePath).isDirectory();
    } catch {
        return false;
    }
}
