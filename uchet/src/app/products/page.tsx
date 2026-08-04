'use client'

import { useCallback, useEffect, useState } from 'react'
import { AppShell } from '@/components/app-shell'
import { ProductsPanel } from '@/components/products-panel'
import type { ProductType } from '@/lib/types'

export default function ProductsPage() {
  const [products, setProducts] = useState<ProductType[]>([])

  const load = useCallback(() => {
    fetch('/api/products?includeInactive=true').then(r => r.json()).then(j => {
      if (j.success) setProducts(Array.isArray(j.data) ? j.data : j.data?.products || [])
    }).catch(() => {})
  }, [])

  useEffect(() => {
    load()
    window.addEventListener('acts:refresh', load)
    return () => window.removeEventListener('acts:refresh', load)
  }, [load])

  return (
    <AppShell>
      <ProductsPanel products={products} />
    </AppShell>
  )
}
