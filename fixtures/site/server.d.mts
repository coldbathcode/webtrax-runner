export declare const EXPECTED: {
  crawledPages: string[]
  brokenInternal: string[]
  brokenExternal: string[]
}

export interface FixtureRequest { method: string; path: string; host: string; ua: string }

export declare function startFixtureSite(options?: { mode?: 'normal' | 'down' | 'slow' }): Promise<{
  origin: string
  externalOrigin: string
  requests: FixtureRequest[]
  close: () => Promise<void>
}>

export declare function startRedirector(target: string): Promise<{ origin: string; close: () => Promise<void> }>
