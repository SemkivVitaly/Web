'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AppShell } from '@/components/app-shell'
import { EmployeesPanel } from '@/components/employees-panel'

export default function EmployeesPage() {
  const [role, setRole] = useState<string | null | undefined>(undefined)

  useEffect(() => {
    fetch('/api/auth').then(r => r.json())
      .then(j => setRole(j?.data?.me?.role ?? null))
      .catch(() => setRole(null))
  }, [])

  return (
    <AppShell>
      {role === undefined ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Загрузка…</p>
      ) : role === 'boss' ? (
        <EmployeesPanel />
      ) : (
        <div className="rounded-lg border bg-card px-6 py-10 text-center space-y-2">
          <p className="font-medium">Раздел доступен только начальнику</p>
          <p className="text-sm text-muted-foreground">
            {role === null
              ? <>Войдите в систему под учётной записью администратора — <Link className="underline" href="/login">войти</Link></>
              : 'Ваша роль не даёт доступа к управлению сотрудниками'}
          </p>
        </div>
      )}
    </AppShell>
  )
}
