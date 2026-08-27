export type ColorCustomizations = Record<string, unknown>;

export interface ManagedColorBackup {
    appliedValue: unknown;
    hadOriginalValue: boolean;
    originalValue?: unknown;
}

export type ManagedColorBackups = Record<string, ManagedColorBackup>;

export interface ManagedColorResult {
    backups: ManagedColorBackups;
    customizations: ColorCustomizations;
}

export function applyManagedColors(
    existing: ColorCustomizations,
    desired: ColorCustomizations,
    previousBackups: ManagedColorBackups
): ManagedColorResult {
    const customizations = { ...existing };
    const backups = { ...previousBackups };

    for (const [key, value] of Object.entries(desired)) {
        const existingBackup = backups[key];
        backups[key] = {
            appliedValue: value,
            hadOriginalValue: existingBackup?.hadOriginalValue ?? Object.hasOwn(existing, key),
            originalValue: existingBackup?.originalValue ?? existing[key]
        };
        customizations[key] = value;
    }

    for (const key of Object.keys(backups)) {
        if (Object.hasOwn(desired, key)) {
            continue;
        }
        restoreManagedColor(customizations, key, backups[key]);
        delete backups[key];
    }

    return { backups, customizations };
}

export function restoreManagedColors(
    existing: ColorCustomizations,
    backups: ManagedColorBackups
): ColorCustomizations {
    const customizations = { ...existing };
    for (const [key, backup] of Object.entries(backups)) {
        restoreManagedColor(customizations, key, backup);
    }
    return customizations;
}

function restoreManagedColor(
    customizations: ColorCustomizations,
    key: string,
    backup: ManagedColorBackup
): void {
    if (customizations[key] !== backup.appliedValue) {
        return;
    }
    if (backup.hadOriginalValue) {
        customizations[key] = backup.originalValue;
    } else {
        delete customizations[key];
    }
}
