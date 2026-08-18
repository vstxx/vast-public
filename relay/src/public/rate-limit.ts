import { sha256Hex } from '../shared/crypto'

export async function sourceRateLimitKey(request: Request, scope: string): Promise<string> {
  const source = request.headers.get('cf-connecting-ip') ?? 'unavailable'
  return sha256Hex(`${scope}\n${source}`)
}

export async function allowedBy(rateLimit: RateLimit, key: string): Promise<boolean> {
  const result = await rateLimit.limit({ key })
  return result.success
}
