import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOTS = process.argv.slice(2)
if (ROOTS.length === 0) { console.error('укажите файлы/папки'); process.exit(1) }

const DIRECTIVE = /^\s*\/[/*]+\s*(eslint|@ts-|prettier|@preserve|@license|c8 |v8 |istanbul|<reference)/i

function commentRanges(text, sf) {
  const seen = new Set()
  const ranges = []
  const push = (r) => {
    const k = r.pos + ':' + r.end
    if (!seen.has(k)) { seen.add(k); ranges.push(r) }
  }
  const visit = (node) => {
    ts.getLeadingCommentRanges(text, node.getFullStart())?.forEach(push)
    ts.getTrailingCommentRanges(text, node.getEnd())?.forEach(push)
    for (const child of node.getChildren(sf)) visit(child)
  }
  visit(sf)
  return ranges.sort((a, b) => a.pos - b.pos)
}

function strip(text, file) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX
    : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const sf = ts.createSourceFile(path.basename(file), text, ts.ScriptTarget.Latest, true, kind)
  const ranges = commentRanges(text, sf)
  let out = '', last = 0
  for (const r of ranges) {
    const raw = text.slice(r.pos, r.end)
    if (DIRECTIVE.test(raw)) continue
    out += text.slice(last, r.pos)
    last = r.end

  }
  out += text.slice(last)
  return out
}

function tidy(code) {
  return code
    .split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*\n/, '')
}

function walk(p, acc) {
  const st = fs.statSync(p)
  if (st.isDirectory()) {
    if (/node_modules|\.next|dist|\.git/.test(p)) return
    for (const e of fs.readdirSync(p)) walk(path.join(p, e), acc)
  } else if (/\.(ts|tsx|mjs|js)$/.test(p)) acc.push(p)
}

const files = []
for (const r of ROOTS) walk(path.resolve(r), files)
let changed = 0
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const out = tidy(strip(src, f))
  if (out !== src) { fs.writeFileSync(f, out); changed++ }
}
console.log(`обработано: ${files.length}, изменено: ${changed}`)
