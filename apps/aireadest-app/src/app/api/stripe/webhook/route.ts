import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  void request;
  return NextResponse.json(
    { error: 'AIReadest has disabled payment and subscription services.' },
    { status: 410 },
  );
}
