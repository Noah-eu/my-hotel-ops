type UnknownRecord = Record<string, unknown>

function isPlainObject(value: unknown): value is UnknownRecord {
    if (!value || typeof value !== 'object') return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

function sanitizeInner(value: unknown): unknown {
    if (value === undefined) return undefined
    if (value === null) return null

    if (Array.isArray(value)) {
        const nextArray: unknown[] = []
        value.forEach((item) => {
            const cleaned = sanitizeInner(item)
            if (cleaned !== undefined) nextArray.push(cleaned)
        })
        return nextArray
    }

    if (isPlainObject(value)) {
        const nextObject: UnknownRecord = {}
        Object.entries(value).forEach(([key, raw]) => {
            const cleaned = sanitizeInner(raw)
            if (cleaned !== undefined) {
                nextObject[key] = cleaned
            }
        })
        return nextObject
    }

    return value
}

export function sanitizeForFirestore<T>(value: T): T {
    return sanitizeInner(value) as T
}

function findUndefinedPath(value: unknown, currentPath = 'root'): string | null {
    if (value === undefined) return currentPath
    if (value === null) return null

    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
            const nested = findUndefinedPath(value[i], `${currentPath}[${i}]`)
            if (nested) return nested
        }
        return null
    }

    if (isPlainObject(value)) {
        for (const [key, nestedValue] of Object.entries(value)) {
            const nested = findUndefinedPath(nestedValue, `${currentPath}.${key}`)
            if (nested) return nested
        }
    }

    return null
}

export function containsUndefinedDeep(value: unknown): boolean {
    return Boolean(findUndefinedPath(value))
}

export function runRollbackBackupSanitizerSelfCheck() {
    const mockPayload = {
        jobId: 'ij-self-check',
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: undefined,
        affectedDates: ['2026-01-01', undefined, '2026-01-02'],
        affectedRoomCount: 2,
        snapshotByDate: {
            '2026-01-01': [
                {
                    roomId: 'r101',
                    roomNumber: '101',
                    schedule: {
                        situation: 'odjezd',
                        departureTime: undefined,
                        arrivalTime: '14:00',
                        guestCount: 0,
                        box: '',
                        notes: ['Poznámka', undefined],
                        occupiedConfirmed: false,
                        freeConfirmed: false,
                        nested: {
                            maybe: undefined,
                            keepNull: null,
                            keepFalse: false
                        }
                    }
                },
                undefined
            ]
        },
        extraArray: [undefined, 0, false, '', null]
    }

    const sanitized = sanitizeForFirestore(mockPayload)
    const undefinedStillExists = findUndefinedPath(sanitized)

    if (undefinedStillExists) {
        throw new Error(`Rollback sanitizer self-check failed at ${undefinedStillExists}`)
    }

    return sanitized
}
