function canonicalValue(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new TypeError('Canonical Relay numbers must be safe integers.')
    return String(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key])}`).join(',')}}`
  }
  throw new TypeError('Canonical Relay payload contains an unsupported value.')
}

export function canonicalize(value: unknown): string {
  return canonicalValue(value)
}
