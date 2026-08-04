import { db } from '@/lib/db'
import { withGroupFromCookies } from '@/lib/with-group-cookies'
import QRCode from 'qrcode'
import { PrintButton } from '@/components/print-button'

export const dynamic = 'force-dynamic'

const num = (v: string | undefined, def: number) => {
  const n = parseFloat(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : def
}

export default async function SerialQrPage(
  { params, searchParams }: {
    params: Promise<{ actId: string }>
    searchParams: Promise<Record<string, string | string[] | undefined>>
  }
) {
  return withGroupFromCookies(async () => {
  const { actId } = await params
  const sp = await searchParams
  const get = (k: string) => (Array.isArray(sp[k]) ? sp[k][0] : sp[k]) as string | undefined

  // Режим Godex по шаблону Template.docx: на КАЖДЫЙ серийник ДВЕ этикетки —
  // текстовая (серийник / дата / Акт № … Т-__) и отдельная с QR. Размер по
  // умолчанию 82.55×50.8 мм (3.25×2"). Меняется в URL: ?w=82.55&h=50.8&qr=44&sn=16
  const godex = get('mode') === 'godex'
  const w = num(get('w'), 82.55)
  const h = num(get('h'), 50.8)
  const qrMm = num(get('qr'), Math.min(w, h) - 6)
  const snPt = num(get('sn'), 16)
  const now = new Date()
  const dateLabel = `___.${String(now.getMonth() + 1).padStart(2, '0')}.${now.getFullYear()}`

  const act = await db.act.findUnique({
    where: { id: actId },
    include: { product: true, units: { orderBy: { serial: 'asc' } } },
  })
  if (!act) return <p style={{ padding: 40 }}>Акт не найден</p>
  const productName = act.product?.name || act.actType

  const labels = await Promise.all(
    act.units.map(async (u) => ({
      serial: u.serial,
      svg: await QRCode.toString(u.serial, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }),
    })),
  )

  if (godex) {
    return (
      <div style={{ background: '#fff', color: '#000' }}>
        <style>{`
          @page { size: ${w}mm ${h}mm; margin: 0; }
          @media print { .print-hide { display: none !important } }
          html, body { margin: 0; padding: 0; }
          .gx {
            width: ${w}mm; height: ${h}mm; box-sizing: border-box;
            page-break-after: always; overflow: hidden;
            font-family: "PT Sans", "Segoe UI", Arial, sans-serif;
          }
          .gx.text { display: flex; flex-direction: column; justify-content: center; padding: 1mm 1.5mm; }
          .gx.text .l { font-weight: 700; font-size: ${snPt}pt; line-height: 1.25; white-space: nowrap; }
          .gx.text .sn { font-size: ${snPt + 1}pt; }
          .gx.qr { display: flex; align-items: center; justify-content: center; }
          .gx.qr .q { width: ${qrMm}mm; height: ${qrMm}mm; }
          .gx.qr .q svg { width: 100%; height: 100%; display: block; }
        `}</style>
        <div className="print-hide" style={{ fontFamily: 'system-ui, sans-serif', padding: '10px 14px', borderBottom: '1px solid #ddd', fontSize: 13, color: '#444' }}>
          <PrintButton />
          <span style={{ marginLeft: 12 }}>
            Godex по шаблону · этикетка {w}×{h} мм · {labels.length} изделий → {labels.length * 2} этикеток (текст + QR).
            В свойствах Godex выберите размер {w}×{h} мм и масштаб 100%.
          </span>
          <div style={{ marginTop: 4, color: '#888' }}>
            Поменять форму/размер: правьте <code>src/app/print/serial-qr/[actId]/page.tsx</code> или
            задайте в адресе <code>?mode=godex&amp;w={w}&amp;h={h}&amp;qr={qrMm}&amp;sn={snPt}</code> (мм и pt).
          </div>
        </div>
        {labels.map((l) => (
          <div key={l.serial}>
            <div className="gx text">
              <div className="l sn">{l.serial}</div>
              <div className="l">{dateLabel}</div>
              <div className="l">Акт № {act.actNumber} Т -__</div>
            </div>
            <div className="gx qr">
              <div className="q" dangerouslySetInnerHTML={{ __html: l.svg }} />
            </div>
          </div>
        ))}
        {labels.length === 0 && <p style={{ padding: 20 }}>Серийные номера в акт не внесены.</p>}
      </div>
    )
  }

  // Режим по умолчанию — сетка на лист A4 (для листовых наклеек)
  return (
    <div style={{ fontFamily: '"Segoe UI", Arial, sans-serif', color: '#000', background: '#fff', minHeight: '100vh', padding: '10mm' }}>
      <style>{`
        @media print { .print-hide { display: none !important } }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6mm; }
        .lbl { border: 1px solid #999; border-radius: 4px; padding: 4mm; text-align: center; break-inside: avoid; }
        .lbl .qr { width: 26mm; height: 26mm; margin: 0 auto; }
        .lbl .qr svg { width: 100%; height: 100%; }
        .lbl .sn { font-family: monospace; font-size: 11px; margin-top: 2mm; word-break: break-all; font-weight: 600; }
        .lbl .meta { font-size: 8px; color: #666; margin-top: 1mm; }
      `}</style>
      <div className="print-hide" style={{ marginBottom: 8 }}>
        <PrintButton />
        <a href={`/print/serial-qr/${actId}?mode=godex`} style={{ marginLeft: 12, fontSize: 13 }}>
          Печать на Godex по шаблону (текст + QR, 82.55×50.8 мм) →
        </a>
      </div>
      <p style={{ fontSize: 12, marginBottom: 6 }}>
        QR-ярлыки на серийные номера · акт <b>{act.actNumber}</b> · {productName} · {labels.length} шт.
        <span style={{ color: '#666' }}> — оклеить каждое изделие; QR кодирует серийный номер (скан на любом этапе).</span>
      </p>
      <div className="grid">
        {labels.map((l) => (
          <div className="lbl" key={l.serial}>
            <div className="qr" dangerouslySetInnerHTML={{ __html: l.svg }} />
            <div className="sn">{l.serial}</div>
            <div className="meta">Акт {act.actNumber} · {productName}</div>
          </div>
        ))}
        {labels.length === 0 && <p style={{ fontSize: 12 }}>Серийные номера в акт не внесены.</p>}
      </div>
      <p style={{ marginTop: 10, fontSize: 9, color: '#888' }}>Только для локального использования</p>
    </div>
  )
  })
}
