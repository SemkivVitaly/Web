import fs from 'fs'
import path from 'path'

export interface LogEntry {
  timestamp: string
  level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG'
  actionType: string
  entityType: string
  entityId: string
  entityNumber?: string
  description: string
  changes?: string
  userId?: string
}

const LOGS_DIR = process.env.UCHET_LOG_DIR || path.join(process.cwd(), 'logs')

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true })
  }
}

function getLogFileName(date: Date = new Date()): string {
  const dateStr = date.toISOString().split('T')[0]
  return path.join(LOGS_DIR, `actions-${dateStr}.log`)
}

function formatLogEntry(entry: LogEntry): string {
  const { timestamp, level, actionType, entityType, entityId, entityNumber, description, changes, userId } = entry

  const parts = [
    `[${timestamp}]`,
    `[${level}]`,
    `[${actionType}]`,
    `[${entityType}]`,
    `id=${entityId}`,
    entityNumber ? `num=${entityNumber}` : '',
    `${description}`,
    changes ? `changes=${changes}` : '',
    userId ? `user=${userId}` : '',
  ].filter(Boolean)

  return parts.join(' | ')
}

export async function writeLogToFile(entry: LogEntry): Promise<void> {
  try {
    ensureLogsDir()

    const logLine = formatLogEntry(entry) + '\n'
    const filePath = getLogFileName()

    await fs.promises.appendFile(filePath, logLine, 'utf-8')
  } catch (error) {
    console.error('Error writing to log file:', error)

  }
}

export async function writeBatchLogs(entries: LogEntry[]): Promise<void> {
  try {
    ensureLogsDir()

    const groupedByDate = new Map<string, LogEntry[]>()

    for (const entry of entries) {
      const date = entry.timestamp.split('T')[0]
      if (!groupedByDate.has(date)) {
        groupedByDate.set(date, [])
      }
      groupedByDate.get(date)!.push(entry)
    }

    for (const [date, dateEntries] of groupedByDate) {
      const filePath = path.join(LOGS_DIR, `actions-${date}.log`)
      const logLines = dateEntries.map(formatLogEntry).join('\n') + '\n'
      await fs.promises.appendFile(filePath, logLines, 'utf-8')
    }
  } catch (error) {
    console.error('Error writing batch logs to file:', error)
  }
}

export async function readLogFile(date?: string): Promise<string[]> {
  try {
    const filePath = date
      ? path.join(LOGS_DIR, `actions-${date}.log`)
      : getLogFileName()

    if (!fs.existsSync(filePath)) {
      return []
    }

    const content = await fs.promises.readFile(filePath, 'utf-8')
    return content.split('\n').filter(line => line.trim())
  } catch (error) {
    console.error('Error reading log file:', error)
    return []
  }
}

export function listLogFiles(): { date: string; path: string; size: number }[] {
  try {
    ensureLogsDir()

    const files = fs.readdirSync(LOGS_DIR)
      .filter(f => f.startsWith('actions-') && f.endsWith('.log'))
      .map(f => {
        const filePath = path.join(LOGS_DIR, f)
        const stat = fs.statSync(filePath)
        return {
          date: f.replace('actions-', '').replace('.log', ''),
          path: filePath,
          size: stat.size,
        }
      })
      .sort((a, b) => b.date.localeCompare(a.date))

    return files
  } catch (error) {
    console.error('Error listing log files:', error)
    return []
  }
}

export async function cleanupOldLogs(olderThanDays: number = 30): Promise<number> {
  try {
    const files = listLogFiles()
    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - olderThanDays)

    let deletedCount = 0

    for (const file of files) {
      const fileDate = new Date(file.date)
      if (fileDate < cutoffDate) {
        await fs.promises.unlink(file.path)
        deletedCount++
      }
    }

    return deletedCount
  } catch (error) {
    console.error('Error cleaning up old logs:', error)
    return 0
  }
}

export function createActLogEntry(
  actionType: string,
  actData: { id: string; actNumber: string; actType: string },
  description: string,
  changes?: string,
  userId?: string
): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level: actionType.includes('ERROR') ? 'ERROR' : actionType.includes('DELETE') ? 'WARN' : 'INFO',
    actionType,
    entityType: 'ACT',
    entityId: actData.id,
    entityNumber: actData.actNumber,
    description,
    changes,
    userId,
  }
}

export function createShipmentLogEntry(
  actionType: string,
  shipmentData: { id: string; shipmentNumber: string },
  description: string,
  changes?: string,
  userId?: string
): LogEntry {
  return {
    timestamp: new Date().toISOString(),
    level: 'INFO',
    actionType,
    entityType: 'SHIPMENT',
    entityId: shipmentData.id,
    entityNumber: shipmentData.shipmentNumber,
    description,
    changes,
    userId,
  }
}
