import { db } from '@/lib/db'
import { withGroupFromCookies } from '@/lib/with-group-cookies'
import { PrintButton } from '@/components/print-button'

export const dynamic = 'force-dynamic'

const OPEN_DEFECT = ['isolator', 'in_repair', 'on_analysis', 'awaiting_decision']

const fmt = (v?: Date | null) =>
  v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export default async function PrintWithdrawalPage(
  { params }: { params: Promise<{ actId: string }> }
) {
  return withGroupFromCookies(async () => {
  const { actId } = await params
  const act = await db.act.findUnique({
    where: { id: actId },
    include: {
      product: true,
      units: { orderBy: { serial: 'asc' } },
      defects: { select: { serial: true, state: true, labelNumber: true } },
    },
  })
  if (!act) return <p style={{ padding: 40 }}>Акт не найден</p>
  const productName = act.product?.name || act.actType

  // Серийники, оставшиеся у нас (в ремонте/изоляторе/на анализе) — НЕ ушли
  const stayed = new Map<string, string>()
  for (const d of act.defects) {
    if (d.serial && OPEN_DEFECT.includes(d.state)) {
      stayed.set(d.serial, d.labelNumber ? `ярлык №${d.labelNumber}` : d.state)
    }
  }
  const heldQty = (act.repairQty || 0) + (act.analysisQty || 0)
  const shippedQty = act.shippedQty || Math.max(0, act.quantity - heldQty)

  const td: React.CSSProperties = { border: '1px solid #000', padding: '4px 6px', fontSize: 12 }
  const th: React.CSSProperties = { ...td, fontWeight: 700 }

  return (
    <div style={{ fontFamily: '"Times New Roman", serif', color: '#000', background: '#fff', minHeight: '100vh', padding: '14mm 16mm' }}>
      <style>{`@media print { .print-hide { display: none !important } }`}</style>
      <PrintButton />
      <h1 style={{ textAlign: 'center', fontSize: 18, fontWeight: 700, marginBottom: 4 }}>АКТ ИЗЪЯТИЯ</h1>
      <p style={{ textAlign: 'center', fontSize: 12, color: '#444', marginBottom: 14 }}>
        (по отгрузке — изделия, вышедшие из УТК)
      </p>
      <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 12 }}>
        <tbody>
          <tr>
            <td style={td}>Дата отгрузки:</td>
            <td style={td}>{fmt(act.actualShipAt)}</td>
            <td style={td}>Наименование изделия:</td>
            <td style={td}>{productName}</td>
          </tr>
          <tr>
            <td style={td}>№ акта ТМЦ:</td>
            <td style={td}>{act.actNumber}</td>
            <td style={td}>Ушло (отгружено), шт.:</td>
            <td style={{ ...td, fontWeight: 700 }}>{shippedQty}</td>
          </tr>
          <tr>
            <td style={td}>Всего в акте, шт.:</td>
            <td style={td}>{act.quantity}</td>
            <td style={td}>Осталось (ремонт/анализ):</td>
            <td style={td}>{heldQty}</td>
          </tr>
        </tbody>
      </table>

      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={th}>№ п/п</th>
            <th style={th}>Серийный номер</th>
            <th style={th}>Выходной контроль</th>
            <th style={th}>Статус</th>
          </tr>
        </thead>
        <tbody>
          {act.units.map((u, i) => {
            const held = stayed.get(u.serial)
            return (
              <tr key={u.id}>
                <td style={{ ...td, textAlign: 'center' }}>{i + 1}</td>
                <td style={{ ...td, fontFamily: 'monospace' }}>{u.serial}</td>
                <td style={td}>{u.outputControlBy || ''}</td>
                <td style={td}>{held ? `осталось у нас (${held})` : 'отгружено'}</td>
              </tr>
            )
          })}
          {act.units.length === 0 && (
            <tr><td style={td} colSpan={4}>Серийные номера в акт не внесены (ушло по количеству: {shippedQty} шт.)</td></tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 36, fontSize: 13 }}>
        <p style={{ marginBottom: 28 }}>
          Отгрузку произвёл (старший техник УТК): _________________ / _________________ / _______________
        </p>
        <p>
          Принял (склад / получатель): _________________ / _________________ / _______________
        </p>
        <p style={{ fontSize: 10, color: '#444', marginTop: 4 }}>(подпись) / (ФИО) / (дата)</p>
      </div>
      <p style={{ marginTop: 18, fontSize: 10, color: '#888', textAlign: 'center' }}>
        Только для локального использования — внутренний документ предприятия
      </p>
    </div>
  )
  })
}
