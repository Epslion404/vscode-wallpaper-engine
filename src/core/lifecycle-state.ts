export type LifecycleOperation = 'setup' | 'uninstall';

/** 统一保护设置与还原操作，避免两个生命周期事务交错执行。 */
export class LifecycleState {
    private operation: LifecycleOperation | undefined;

    public constructor(private isDisabled = false) {}

    public get currentOperation(): LifecycleOperation | undefined {
        return this.operation;
    }

    public get disabled(): boolean {
        return this.isDisabled;
    }

    public setDisabled(disabled: boolean): void {
        this.isDisabled = disabled;
    }

    public tryBegin(operation: LifecycleOperation): boolean {
        if (this.operation !== undefined) {
            return false;
        }
        this.operation = operation;
        return true;
    }

    public end(operation: LifecycleOperation): void {
        if (this.operation === operation) {
            this.operation = undefined;
        }
    }
}
