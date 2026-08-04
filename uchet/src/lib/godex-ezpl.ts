interface EzplOpts {
  actNumber: string
  dateLabel?: string
}

const esc = (s: string) => s.replace(/"/g, '')

export function buildUnitEzpl(serial: string, o: EzplOpts): string {
  const sn = esc(serial)
  const act = esc(o.actNumber)
  const date = o.dateLabel ?? '__.__.____'
  return [
    '^L',
    '^W101',
    '^Q50,3',
    `A,50,40,0,4,1,1,N,"${sn}"`,
    `A,50,120,0,4,1,1,N,"${date}"`,
    `A,50,200,0,4,1,1,N,"ACT ${act} T-__"`,
    'E',
    '^L',
    '^W101',
    '^Q50,3',
    `W300,80,1,2,M,8,6,${sn.length},0`,
    sn,
    'E',
  ].join('\r\n')
}

export function buildActEzpl(serials: string[], o: EzplOpts): string {
  return serials.map(s => buildUnitEzpl(s, o)).join('\r\n') + '\r\n'
}

export function monthYearLabel(d = new Date()): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `__.${mm}.${d.getFullYear()}`
}
