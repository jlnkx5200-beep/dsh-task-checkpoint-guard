/** Small, bounded audit writer shared by concept transitions. */
export function addAuditEntry(document, entry, options = {}) {
  const max = Number.isSafeInteger(options.maxMemoryAuditEntries)
    ? options.maxMemoryAuditEntries
    : 200
  if (max <= 0 || !Array.isArray(document?.audit)) return
  document.audit.push({
    at: Number.isSafeInteger(entry?.at) ? entry.at : Date.now(),
    action: entry?.action ?? null,
    memoryId: entry?.memoryId ?? null,
    conceptId: entry?.conceptId ?? null,
    detail: entry?.detail ?? null,
  })
  document.audit = document.audit.slice(-max)
}
