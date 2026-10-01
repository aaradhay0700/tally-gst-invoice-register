// Browser-local history of generated registers. Files live in this browser's
// IndexedDB only -- nothing is uploaded -- so history is per browser/device.

export interface HistoryEntry {
  id: string
  createdAt: number
  sourceFilename: string
  baseFilename: string
  company: string
  state: string
  period: string
  voucherCount: number
  verificationPassed: boolean
  xlsx: ArrayBuffer
  csv: string
}

const DB_NAME = 'tally-register-history'
const STORE = 'entries'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export async function listHistory(): Promise<HistoryEntry[]> {
  const all = await run<HistoryEntry[]>('readonly', (s) => s.getAll())
  return all.sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveHistory(entry: Omit<HistoryEntry, 'id' | 'createdAt'>): Promise<void> {
  await run('readwrite', (s) => s.put({ ...entry, id: crypto.randomUUID(), createdAt: Date.now() }))
}

export async function deleteHistory(id: string): Promise<void> {
  await run('readwrite', (s) => s.delete(id))
}
