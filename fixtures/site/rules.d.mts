export declare const FIXTURE_TODAY: string
export declare const FIXTURE_DICTIONARY: { term: string; use?: string }[]
export declare const FIXTURE_HOSTS: string[]
export declare const DEFECTS: Record<string, Record<string, unknown>>
/** Rules found somewhere other than /defects/<rule>: paths on shop.example, full URLs elsewhere, null for site-wide. */
export declare const ELSEWHERE: Record<string, (string | null)[]>
export declare const CLEAN_ALLOWED: string[]
export declare const FIXTURE_LOOKUPS: {
  dns(host: string): Promise<{ status: 'ok' | 'nxdomain' | 'error'; cname: string[]; addresses: string[] }>
  registration(domain: string): Promise<'registered' | 'available' | 'unknown'>
}
export declare function prose(seed: string, n?: number): string
export declare function startRulesSite(): Promise<{ port: number; requests: { method: string; url: string; ua: string }[]; close: () => Promise<void> }>
export declare function virtualFetch<P>(port: number, policy: P): {
  (url: string, init?: RequestInit & { originHeaders?: unknown }): Promise<{ response: Response; url: string; chain: { url: string; status: number }[] }>
  policy: P
  close(): Promise<void>
}
