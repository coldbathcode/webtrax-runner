export declare const MEASURE_DEFECTS: Record<string, Record<string, unknown>>
export declare const SLOW_CSS_MS: number
export declare const SLOW_HTML_MS: number
export declare function startBrowserSite(kind: 'measure' | 'device' | 'engines', options?: { clean?: boolean }): Promise<{ origin: string; close: () => Promise<void> }>
