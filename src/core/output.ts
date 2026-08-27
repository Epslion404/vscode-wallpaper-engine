import * as vscode from 'vscode';
import { WallpaperSetupStage } from './wallpaper-setup';
import { redactLocalDetails } from './user-message';

export function describeError(error: unknown): string {
    if (!(error instanceof Error)) {
        return redactLocalDetails(String(error));
    }
    const lines = [`${error.name}: ${redactLocalDetails(error.message)}`];
    if (error.stack) {
        lines.push(redactLocalDetails(error.stack));
    }
    if (error.cause !== undefined) {
        lines.push(`Cause: ${describeError(error.cause)}`);
    }
    return lines.join('\n');
}

export class WallpaperOutput implements vscode.Disposable {
    private readonly channel = vscode.window.createOutputChannel('Wallpaper Engine');

    public info(operationId: string, message: string): void {
        this.append(operationId, 'INFO', message);
    }

    public stage(operationId: string, stage: WallpaperSetupStage, message: string): void {
        this.append(operationId, 'STAGE', `${stage}: ${message}`);
    }

    public error(operationId: string, message: string, error: unknown): void {
        this.append(operationId, 'ERROR', `${message}\n${describeError(error)}`);
    }

    public show(): void {
        this.channel.show(true);
    }

    public dispose(): void {
        this.channel.dispose();
    }

    private append(operationId: string, level: string, message: string): void {
        const timestamp = new Date().toISOString();
        this.channel.appendLine(`[${timestamp}] [${operationId}] [${level}] ${message}`);
    }
}
