import type { db } from './index.js'

// A transaction handed to a gateway write, so a caller can make several
// writes atomic (features/service-queue/dispatcher.ts).
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

// Either the pool or an open transaction.
export type DbExecutor = typeof db | DbTransaction
