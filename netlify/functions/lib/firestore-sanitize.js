function isPlainObject(value) {
    if (value === null || typeof value !== 'object') return false
    const proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
}

function sanitizeFirestoreValue(value, path, removedPaths) {
    if (value === undefined) {
        removedPaths.push(path || '<root>')
        return undefined
    }

    if (value === null) return null

    if (value instanceof Date) return value

    if (Array.isArray(value)) {
        const arr = []
        value.forEach((item, index) => {
            const cleaned = sanitizeFirestoreValue(item, `${path}[${index}]`, removedPaths)
            if (cleaned !== undefined) arr.push(cleaned)
            else removedPaths.push(`${path}[${index}]`)
        })
        return arr
    }

    if (isPlainObject(value)) {
        const out = {}
        Object.entries(value).forEach(([key, child]) => {
            const childPath = path ? `${path}.${key}` : key
            const cleaned = sanitizeFirestoreValue(child, childPath, removedPaths)
            if (cleaned !== undefined) out[key] = cleaned
        })
        return out
    }

    return value
}

function sanitizeForFirestore(input, rootPath = '') {
    const removedPaths = []
    const cleaned = sanitizeFirestoreValue(input, rootPath, removedPaths)
    return { cleaned, removedPaths }
}

function runSanitizerSelfCheck() {
    const sample = {
        keepNull: null,
        keepFalse: false,
        keepZero: 0,
        keepEmpty: '',
        nested: {
            gone: undefined,
            keep: 'x',
            deeper: {
                missing: undefined,
                list: [1, undefined, null, 0, false, '']
            }
        },
        list: [
            undefined,
            { a: 1, b: undefined },
            'ok'
        ]
    }

    const { cleaned } = sanitizeForFirestore(sample, 'selfCheck')

    if (Object.prototype.hasOwnProperty.call(cleaned.nested, 'gone')) {
        throw new Error('Firestore sanitizer self-check failed: nested undefined key still present.')
    }
    if (Object.prototype.hasOwnProperty.call(cleaned.nested.deeper, 'missing')) {
        throw new Error('Firestore sanitizer self-check failed: deep undefined key still present.')
    }
    if (cleaned.keepNull !== null || cleaned.keepFalse !== false || cleaned.keepZero !== 0 || cleaned.keepEmpty !== '') {
        throw new Error('Firestore sanitizer self-check failed: valid falsey values were modified.')
    }
    if (!Array.isArray(cleaned.list) || cleaned.list.length !== 2) {
        throw new Error('Firestore sanitizer self-check failed: array undefined values were not removed.')
    }
}

module.exports = {
    sanitizeForFirestore,
    runSanitizerSelfCheck
}
