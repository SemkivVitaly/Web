/* __uchetGroupWrapped */
import { NextResponse } from 'next/server';
import { listLogFiles, readLogFile } from '@/lib/file-logger';
import { withGroupFromRequest } from '@/lib/group-context'

export async function GET(request: Request) {
  return withGroupFromRequest(request, async () => {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get('date')
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return NextResponse.json({ success: false, error: 'Неверный формат даты' }, { status: 400 })
    };

    if (date) {
      const lines = await readLogFile(date);
      return NextResponse.json({
        success: true,
        data: {
          date,
          lines,
          count: lines.length,
        },
      });
    }

    const files = listLogFiles();

    return NextResponse.json({
      success: true,
      data: files,
      total: files.length,
    });
  } catch (error) {
    console.error('Error reading log files:', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка при чтении лог-файлов' },
      { status: 500 }
    );
  }
  })
}
