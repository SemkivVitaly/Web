/**
 * Оборачивает HTTP-методы в route.ts: withGroupFromRequest(request, async () => { ... }).
 * Идемпотентно.
 */
import fs from 'fs'
import path from 'path'

const apiRoot = path.join(process.cwd(), 'src', 'app', 'api')

function walk(dir) {
  const out = []
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) out.push(...walk(p))
    else if (ent.name === 'route.ts') out.push(p)
  }
  return out
}

function findMatchingBrace(src, openIdx) {
  let depth = 0
  let inStr = null
  let escape = false
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (escape) {
        escape = false
        continue
      }
      if (ch === '\\') {
        escape = true
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

const IMPORT_LINE = `import { withGroupFromRequest } from '@/lib/group-context'`

for (const file of walk(apiRoot)) {
  let src = fs.readFileSync(file, 'utf8')
  if (src.includes('__uchetGroupWrapped')) {
    console.log('skip', path.relative(process.cwd(), file))
    continue
  }

  if (!src.includes(IMPORT_LINE)) {
    const lines = src.split('\n')
    let lastImport = -1
    for (let i = 0; i < lines.length; i++) {
      if (/^import\s/.test(lines[i])) lastImport = i
    }
    lines.splice(lastImport + 1, 0, IMPORT_LINE)
    src = lines.join('\n')
  }

  const re = /export async function (GET|POST|PUT|PATCH|DELETE)\(([^)]*)\)\s*\{/g
  const pieces = []
  let last = 0
  let m
  while ((m = re.exec(src))) {
    const params = m[2]
    const reqName = (params.split(',')[0] || 'request').trim().split(':')[0].trim() || 'request'
    const openBrace = m.index + m[0].length - 1
    const closeBrace = findMatchingBrace(src, openBrace)
    if (closeBrace < 0) throw new Error(`No closing brace in ${file} for ${m[1]}`)
    const body = src.slice(openBrace + 1, closeBrace)
    pieces.push(src.slice(last, m.index))
    pieces.push(
      `export async function ${m[1]}(${params}) {\n` +
        `  return withGroupFromRequest(${reqName}, async () => {` +
        body +
        `  })\n}`,
    )
    last = closeBrace + 1
    re.lastIndex = closeBrace + 1
  }
  pieces.push(src.slice(last))
  src = pieces.join('')
  src = `/* __uchetGroupWrapped */\n` + src
  fs.writeFileSync(file, src)
  console.log('ok', path.relative(process.cwd(), file))
}
