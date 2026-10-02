import { DatabaseSync } from 'node:sqlite';

// Keep an OS-backed SQLite reservation for the broker's entire lifetime. A
// crashed process releases it automatically; competitors must never unlink a
// live Unix socket. The sidecar must not be deleted while brokers are running.
export function acquireUnixBrokerLease(endpoint: string): DatabaseSync | null {
  const db = new DatabaseSync(`${endpoint}.lease.sqlite`);
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE');
    return db;
  } catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5) return null;
    throw error;
  }
}
