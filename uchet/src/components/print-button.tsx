'use client'

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="print-hide fixed top-4 right-4 rounded-lg border bg-white px-5 py-2.5 text-sm font-semibold shadow hover:bg-gray-50"
    >
      Печать
    </button>
  )
}
