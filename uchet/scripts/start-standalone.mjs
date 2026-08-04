import { cpSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const standalone = path.join(root, '.next', 'standalone')
if (!existsSync(standalone)) {
  console.error('Сначала соберите проект: npm run build (или bun run build)')
  process.exit(1)
}
cpSync(path.join(root, '.next', 'static'), path.join(standalone, '.next', 'static'), { recursive: true })
cpSync(path.join(root, 'public'), path.join(standalone, 'public'), { recursive: true })
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'file:' + path.join(root, 'db', 'custom.db').replace(/\\/g, '/')
}
const child = spawn('node', [path.join(standalone, 'server.js')], {
  stdio: 'inherit',
  env: { HOSTNAME: '0.0.0.0', UCHET_LOG_DIR: path.join(root, 'logs'), ...process.env },
})
child.on('exit', code => process.exit(code ?? 0))
