import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:' + path.join(root, 'db', 'custom.db').replace(/\\/g, '/')
}
const cmd = process.argv[2] || 'push'
const args = cmd === 'push'
  ? ['prisma', 'db', 'push', '--accept-data-loss', '--skip-generate']
  : ['prisma', cmd]
const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
  cwd: root, stdio: 'inherit', env: process.env,
})
process.exit(r.status ?? 1)
