import { db } from '@/lib/db'
import { withGroupFromCookies } from '@/lib/with-group-cookies'
import { DEFECT_STATES } from '@/lib/statuses'
import { PrintButton } from '@/components/print-button'

export const dynamic = 'force-dynamic'

export default async function PrintNcActPage(
  { params }: { params: Promise<{ actId: string }> }
) {
  return withGroupFromCookies(async () => {
  const { actId } = await params
  const act = await db.act.findUnique({
    where: { id: actId },
    include: { product: true, defects: { orderBy: { createdAt: 'asc' } } },
  })
  if (!act) return <p style={{ padding: 40 }}>Акт не найден</p>
  const productName = act.product?.name || act.actType

  const th: React.CSSProperties = { border: '1px solid #000', padding: '4px 6px', fontSize: 12, fontWeight: 700 }
  const td: React.CSSProperties = { border: '1px solid #000', padding: '4px 6px', fontSize: 12 }

  return (
    <div style={{ fontFamily: '"Times New Roman", serif', color: '#000', background: '#fff', minHeight: '100vh', padding: '14mm 16mm' }}>
      <style>{`@media print { .print-hide { display: none !important } }`}</style>
      <PrintButton />
      <h1 style={{ textAlign: 'center', fontSize: 18, fontWeight: 700, marginBottom: 14 }}>АКТ НЕСООТВЕТСТВИЯ</h1>
      <table style={{ borderCollapse: 'collapse', width: '100%', marginBottom: 12 }}>
        <tbody>
          <tr>
            <td style={td}>Дата составления:</td>
            <td style={td}>{new Date().toLocaleDateString('ru-RU')}</td>
            <td style={td}>Наименование изделия:</td>
            <td style={td}>{productName}</td>
          </tr>
          <tr>
            <td style={td}>№ акта несоответствия:</td>
            <td style={td}>{act.ncActNumber || '—'}</td>
            <td style={td}>Версия сборки:</td>
            <td style={td}>—</td>
          </tr>
          <tr>
            <td style={td}>№ акта ТМЦ:</td>
            <td style={td}>{act.actNumber}</td>
            <td style={td}>Кол-во:</td>
            <td style={td}>{act.defects.length}</td>
          </tr>
        </tbody>
      </table>

      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={th}>№ п/п</th>
            <th style={th}>Серийный номер</th>
            <th style={th}>Описание выявленных несоответствий</th>
            <th style={th}>Десигнатор</th>
            <th style={th}>Примечание</th>
          </tr>
        </thead>
        <tbody>
          {act.defects.map((d, i) => (
            <tr key={d.id}>
              <td style={{ ...td, textAlign: 'center' }}>{i + 1}</td>
              <td style={td}>{d.serial || ''}</td>
              <td style={td}>{d.description || ''}</td>
              <td style={{ ...td, textAlign: 'center' }}>{d.designator || ''}</td>
              <td style={td}>
                {DEFECT_STATES[d.state] || d.state}
                {d.labelNumber ? ` / ${d.labelNumber}` : ''}
                {d.reportedBy ? ` / ${d.reportedBy}` : ''}
              </td>
            </tr>
          ))}
          {act.defects.length === 0 && (
            <tr><td style={td} colSpan={5}>Несоответствий не зафиксировано</td></tr>
          )}
        </tbody>
      </table>

      <div style={{ marginTop: 36, fontSize: 13 }}>
        <p style={{ marginBottom: 28 }}>
          Сдал на контроль: _________________ / _________________ / _______________
          <span style={{ fontSize: 10, color: '#444' }}><br />
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            (подпись)&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            (ФИО)&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            (дата)
          </span>
        </p>
        <p>
          Старший техник УТК: _________________ / _________________ / _______________
          <span style={{ fontSize: 10, color: '#444' }}><br />
            &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            (подпись)&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            (ФИО)&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
            (дата)
          </span>
        </p>
      </div>
          <p style={{ marginTop: 18, fontSize: 10, color: '#888', textAlign: 'center' }}>
        Только для локального использования — внутренний документ предприятия
      </p>
</div>
  )
  })
}
