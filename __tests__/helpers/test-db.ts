import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import Database from 'better-sqlite3'

/** A SQLite database at `file` with every Prisma migration applied; returns its DATABASE_URL */
export function createTestDatabase(file: string, extraSql = ''): string {
  const sqlite = new Database(file)
  const migrations = path.join(process.cwd(), 'prisma', 'migrations')
  for (const name of readdirSync(migrations).filter((n) => /^\d/.test(n)).sort()) {
    sqlite.exec(readFileSync(path.join(migrations, name, 'migration.sql'), 'utf8'))
  }
  if (extraSql) sqlite.exec(extraSql)
  sqlite.close()
  return `file:${file}`
}
