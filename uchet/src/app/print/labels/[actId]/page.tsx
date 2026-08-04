import { db } from '@/lib/db'
import { withGroupFromCookies } from '@/lib/with-group-cookies'
import { DEFECT_KINDS } from '@/lib/statuses'
import { PrintButton } from '@/components/print-button'

export const dynamic = 'force-dynamic'

const box = (checked: boolean) => (
  <span style={{
    display: 'inline-block', width: 12, height: 12, border: '1.5px solid #000',
    marginRight: 6, verticalAlign: 'middle', textAlign: 'center', lineHeight: '11px',
    fontSize: 11, fontWeight: 700,
  }}>{checked ? '✕' : ' '}</span>
)

export default async function PrintLabelsPage(
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
  const defects = act.defects

  return (
    <div style={{ fontFamily: '"Times New Roman", serif', color: '#000', background: '#fff', minHeight: '100vh' }}>
      <style>{`
        @media print { .print-hide { display: none !important } body { background: #fff } }
        .label { border-bottom: 1.5px dashed #000; padding: 8mm 10mm; page-break-inside: avoid; }
        .label:nth-of-type(3n) { page-break-after: always; border-bottom: none; }
        .row { display: flex; justify-content: space-between; gap: 16px; margin-top: 5px; font-size: 13px; }
        .u { border-bottom: 1px solid #000; min-width: 120px; display: inline-block; padding: 0 4px; }
      `}</style>
      <PrintButton />
      {defects.length === 0 && <p style={{ padding: 40 }}>В акте {act.actNumber} нет ярлыков несоответствия</p>}
      {defects.map(d => (
        <div className="label" key={d.id}>
          <div className="row" style={{ fontWeight: 700, fontSize: 14 }}>
            <span>ЯРЛЫК НЕСООТВЕТСТВИЯ № <span className="u">{d.labelNumber || ' '}</span></span>
            <span>Дата: <span className="u">{new Date(d.createdAt).toLocaleDateString('ru-RU')}</span></span>
          </div>
          <div className="row">
            <span>Наименование изделия: <span className="u" style={{ minWidth: 180 }}>{productName}</span></span>
            <span>Акт: <span className="u">{act.actNumber}</span></span>
          </div>
          <div className="row">
            <span>Участок: <span className="u">УТК</span></span>
            <span>Серийный номер: <span className="u" style={{ minWidth: 140 }}>{d.serial || ' '}</span></span>
            <span>Десигнатор: <span className="u">{d.designator || ' '}</span></span>
          </div>
          <div className="row">
            <span style={{ flex: 1 }}>
              Описание дефектов ({DEFECT_KINDS[d.kind] || d.kind}{d.kind === 'mass' || d.quantity > 1 ? `, ${d.quantity} шт.` : ''}):{' '}
              <span className="u" style={{ minWidth: '70%' }}>{d.description || ' '}</span>
            </span>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <span style={{ fontSize: 12 }}>
              Статус изделия:&nbsp;&nbsp;
              {box(d.state === 'isolator')} Изолировано (Не устранимо)&nbsp;&nbsp;
              {box(d.state === 'in_repair' || d.state === 'on_analysis' || d.state === 'awaiting_decision')} На доработку (Ремонт)&nbsp;&nbsp;
              {box(d.state === 'deviation_approved')} Отклонение разрешено
            </span>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <span>ФИО/Подпись: <span className="u" style={{ minWidth: 160 }}>{d.reportedBy || ' '}</span> / ____________</span>
            <span>Проверил: <span className="u" style={{ minWidth: 120 }}>{d.checkedBy || ' '}</span> / ____________</span>
          </div>
        </div>
      ))}
          <p style={{ marginTop: 18, fontSize: 10, color: '#888', textAlign: 'center' }}>
        Только для локального использования — внутренний документ предприятия
      </p>
</div>
  )
  })
}
