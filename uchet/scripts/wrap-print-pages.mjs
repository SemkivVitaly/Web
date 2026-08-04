import fs from 'fs'

const files = [
  'src/app/print/nc-act/[actId]/page.tsx',
  'src/app/print/labels/[actId]/page.tsx',
  'src/app/print/route-card/[actId]/page.tsx',
  'src/app/print/withdrawal/[actId]/page.tsx',
  'src/app/print/serial-qr/[actId]/page.tsx',
]

for (const f of files) {
  let s = fs.readFileSync(f, 'utf8')
  if (s.includes('withGroupFromCookies')) {
    console.log('skip', f)
    continue
  }
  if (!s.includes("from '@/lib/with-group-cookies'")) {
    s = s.replace(
      "import { db } from '@/lib/db'",
      "import { db } from '@/lib/db'\nimport { withGroupFromCookies } from '@/lib/with-group-cookies'",
    )
  }
  s = s.replace(
    /(export default async function \w+\([^)]*\)\s*\{)\s*(const \{ actId \} = await params)/,
    '$1\n  return withGroupFromCookies(async () => {\n  $2',
  )
  const idx = s.lastIndexOf('\n}')
  if (idx > 0 && !s.includes('  })\n}')) {
    s = s.slice(0, idx) + '\n  })\n}' + s.slice(idx + 2)
  }
  fs.writeFileSync(f, s)
  console.log('ok', f)
}
