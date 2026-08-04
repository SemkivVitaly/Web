import { db } from '@/lib/db'
import { withGroupFromCookies } from '@/lib/with-group-cookies'
import { PrintButton } from '@/components/print-button'

export const dynamic = 'force-dynamic'

const fmt = (v?: Date | null) =>
  v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''

const sig = (by?: string | null, at?: Date | null) =>
  by ? `${by}${at ? ` · ${fmt(at)}` : ''}` : ''

export default async function RouteCardPage(
  { params }: { params: Promise<{ actId: string }> }
) {
  return withGroupFromCookies(async () => {
  const { actId } = await params
  const act = await db.act.findUnique({
    where: { id: actId },
    include: {
      product: true,
      units: { orderBy: { serial: 'asc' } },
      defects: { select: { serial: true, labelNumber: true, state: true } },
    },
  })
  if (!act) return <p style={{ padding: 40 }}>Акт не найден</p>
  const productName = act.product?.name || act.actType
  const defBySerial = new Map<string, string[]>()
  for (const d of act.defects) {
    if (!d.serial) continue
    const arr = defBySerial.get(d.serial) || []
    arr.push(`${d.labelNumber ? '№' + d.labelNumber + ' ' : ''}${d.state}`)
    defBySerial.set(d.serial, arr)
  }

  const td: React.CSSProperties = { border: '1px solid #000', padding: '3px 5px', fontSize: 11 }
  const th: React.CSSProperties = { ...td, fontWeight: 700, textAlign: 'center' }

  return (
    <div style={{ fontFamily: '"Times New Roman", serif', color: '#000', background: '#fff', minHeight: '100vh', padding: '12mm 12mm' }}>
      <style>{`@media print { .print-hide { display: none !important } }`}</style>
      <PrintButton />
      <h1 style={{ textAlign: 'center', fontSize: 16, fontWeight: 700, marginBottom: 10 }}>
        МАРШРУТНАЯ КАРТА · ПРОСЛЕЖИВАЕМОСТЬ ПО ИЗДЕЛИЯМ
      </h1>
      <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 10 }}>
        <tbody>
          <tr>
            <td style={td}>Акт ТМЦ:</td><td style={td}>{act.actNumber}</td>
            <td style={td}>Изделие:</td><td style={td}>{productName}</td>
            <td style={td}>Кол-во:</td><td style={td}>{act.quantity}</td>
          </tr>
          <tr>
            <td style={td}>Источник:</td><td style={td}>{act.source}</td>
            <td style={td}>Назначение:</td><td style={td}>{act.purpose}</td>
            <td style={td}>Серийников:</td><td style={td}>{act.units.length}</td>
          </tr>
        </tbody>
      </table>

      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={th}>№</th>
            <th style={th}>Серийный номер</th>
            <th style={th}>Приёмка<br />(старший)</th>
            <th style={th}>Входной контроль<br />(осмотр SMD)</th>
            <th style={th}>Тестирование<br />(кто сделал)</th>
            <th style={th}>Выходной контроль<br />(старший)</th>
            <th style={th}>Несоответствия</th>
          </tr>
        </thead>
        <tbody>
          {act.units.map((u, i) => (
            <tr key={u.id}>
              <td style={{ ...td, textAlign: 'center' }}>{i + 1}</td>
              <td style={{ ...td, fontFamily: 'monospace' }}>{u.serial}</td>
              <td style={td}>{sig(u.acceptedBy, u.acceptedAt)}</td>
              <td style={td}>{sig(u.inputControlBy, u.inputControlAt)}</td>
              <td style={td}>{sig(u.testedBy, u.testedAt)}</td>
              <td style={td}>{sig(u.outputControlBy, u.outputControlAt)}</td>
              <td style={td}>{(defBySerial.get(u.serial) || []).join('; ')}</td>
            </tr>
          ))}
          {act.units.length === 0 && (
            <tr><td style={td} colSpan={7}>Серийные номера в акт не внесены</td></tr>
          )}
        </tbody>
      </table>

      <p style={{ marginTop: 24, fontSize: 12 }}>
        Отгрузку произвёл (старший техник): _________________ / _________________ / _______________
        <span style={{ fontSize: 10, color: '#444' }}> (подпись / ФИО / дата)</span>
      </p>
      <p style={{ marginTop: 14, fontSize: 10, color: '#888', textAlign: 'center' }}>
        Только для локального использования — внутренний документ предприятия
      </p>
    </div>
  )
  })
}
