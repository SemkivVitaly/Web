export interface ProductType {
  id: string
  code: string
  name: string
  sku?: string | null
  category?: string | null
  unit: string
  isActive?: boolean
}

export interface Act {
  id: string
  actNumber: string
  actDate: string
  actTime: string
  actType: string
  quantity: number
  source?: string
  status: string
  createdAt: string
  updatedAt?: string

  statusDates?: Record<string, string>
  productId?: string | null
  product?: ProductType | null
  ncActNumber?: string | null
  repairQty?: number
  shippedQty?: number
  analysisQty?: number
  plannedShipAt?: string | null
  actualShipAt?: string | null
  outputControlBy?: string | null
  takenBy?: string | null
  notes?: string | null
}

export interface ActionLogEntry {
  id: string
  actionType: string
  entityType: string
  entityNumber?: string | null
  description: string
  userId?: string | null
  createdAt: string
}
