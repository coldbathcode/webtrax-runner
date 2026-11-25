/**
 * Single-file HTML report: offline (no external assets, no script), readable
 * in light and dark mode, and accessible (landmarks, one h1, ordered
 * headings, table captions and header scopes, colour contrast >= 4.5:1;
 * checked with axe in test/html.test.ts). Every value that came from the
 * crawled site is escaped; only http(s) URLs become links.
 */
import { SEVERITIES } from '@webtrax/protocol'
import { caveatText, countsText, durationText, kilobytes, PROFILE_LABELS, profileText, seconds, speedProfiles, statusText, target, type FindingGroup, type Report, type SpeedRow } from './model'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
/** Lab speed by browser profile, the slowest pages first. Empty without measurements. */
function speedSection(r: Report): string {
  const profiles = speedProfiles(r.speed)
  if (!profiles.length) return ''
  const worst = (row: SpeedRow) => Math.max(...profiles.map((p) => row.profiles[p]?.lcp_ms ?? 0))
  const rows = [...r.speed].sort((a, b) => worst(b) - worst(a)).slice(0, 50)
  return `<section aria-labelledby="speed">
<h2 id="speed">Speed by device</h2>
<p class="muted">Lab measurements from one load each. Phone is Chromium as a mid-range phone on slow 4G, not a real device.</p>
<table>
<caption>Largest contentful paint, layout shift and page weight for ${rows.length} of ${r.speed.length} page${r.speed.length === 1 ? '' : 's'}</caption>
<thead><tr><th scope="col">Page</th>${profiles.map((p) => `<th scope="col">${PROFILE_LABELS[p]} LCP</th><th scope="col">${PROFILE_LABELS[p]} CLS</th><th scope="col">${PROFILE_LABELS[p]} weight</th>`).join('')}</tr></thead>
<tbody>
${rows.map((row) => `<tr><th scope="row">${link(row.url)}</th>${profiles.map((p) => `<td>${seconds(row.profiles[p]?.lcp_ms)}</td><td>${row.profiles[p]?.cls ?? '—'}</td><td>${kilobytes(row.profiles[p]?.transfer_bytes)}</td>`).join('')}</tr>`).join('\n')}
</tbody>
</table>
</section>
`
}

const link = (url: string) => (/^https?:\/\//i.test(url) ? `<a href="${esc(url)}">${esc(url)}</a>` : esc(url))
const label = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`

const CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1a1a1a;--muted:#4a4a4a;--line:#d0d4d9;--soft:#f4f6f8;--link:#0b57d0;
--critical:#6b21a8;--high:#b91c1c;--medium:#8a4b00;--low:#155e75;--info:#4b5563}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e8eaed;--muted:#b4bac2;--line:#3a3f47;--soft:#1b1f25;--link:#8ab4f8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header,main,footer{max-width:60rem;margin:0 auto;padding:1rem}a{color:var(--link)}
h1{font-size:1.6rem;margin:.25rem 0;overflow-wrap:anywhere}h2{font-size:1.3rem;margin-top:2rem}h3{font-size:1.1rem;margin-top:1.5rem}
.muted{color:var(--muted)}.brand{font-weight:700;margin:0}
dl.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem;margin:0}
dl.stats div{border:1px solid var(--line);border-radius:.5rem;padding:.75rem;background:var(--soft)}dl.stats dt{color:var(--muted);font-size:.875rem}dl.stats dd{margin:0;font-size:1.25rem;font-weight:600}
ul.findings{list-style:none;padding:0;margin:0}ul.findings li{border:1px solid var(--line);border-radius:.5rem;margin:.5rem 0;background:var(--soft)}
summary{cursor:pointer;padding:.75rem;overflow-wrap:anywhere}details[open] summary{border-bottom:1px solid var(--line)}.body{padding:.75rem}
.badge{display:inline-block;min-width:4.5rem;text-align:center;border-radius:.25rem;padding:0 .4rem;margin-right:.5rem;font-size:.8rem;font-weight:700;color:#fff}
.critical{background:var(--critical)}.high{background:var(--high)}.medium{background:var(--medium)}.low{background:var(--low)}.info{background:var(--info)}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em}
table{border-collapse:collapse;width:100%}caption{text-align:left;color:var(--muted);padding:.25rem 0}th,td{border-bottom:1px solid var(--line);padding:.4rem;text-align:left;vertical-align:top;overflow-wrap:anywhere}
`

function evidenceList(f: FindingGroup): string {
  const entries = Object.entries(f.evidence).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0))
  if (!entries.length) return ''
  const value = (v: unknown) => (Array.isArray(v) ? v.map((x) => link(String(x))).join(', ') : typeof v === 'object' ? esc(JSON.stringify(v)) : link(String(v)))
  return `<p><strong>Evidence</strong></p><ul>${entries.map(([k, v]) => `<li>${esc(k.replace(/_/g, ' '))}: ${value(v)}</li>`).join('')}</ul>`
}

function finding(f: FindingGroup): string {
  const sources = f.sources.length
    ? `<p><strong>Seen on</strong> ${f.sources.length} page${f.sources.length === 1 ? '' : 's'}:</p><ul>${f.sources.slice(0, 20).map((u) => `<li>${link(u)}</li>`).join('')}${f.sources.length > 20 ? `<li>and ${f.sources.length - 20} more</li>` : ''}</ul>`
    : ''
  const rule = f.rule ? `<p><strong>Why it matters.</strong> ${esc(f.rule.why)}</p><p><strong>How to fix.</strong> ${esc(f.rule.fix)}</p>` : ''
  return `<li><details><summary><span class="badge ${f.severity}">${f.severity.toUpperCase()}</span>${esc(f.title)}: ${esc(f.url ?? 'site-wide')}</summary>
<div class="body"><p>${f.url ? link(f.url) : 'Applies to the whole site.'}</p>${rule}${evidenceList(f)}${sources}<p class="muted">Rule <code>${esc(f.rule_id)}</code> · finding <code>${esc(f.id)}</code></p></div></details></li>`
}

export function renderHtml(r: Report): string {
  const s = r.summary
  const host = (() => { try { return new URL(target(r)).host } catch { return target(r) } })()
  const findings = SEVERITIES.map((sev) => {
    const group = r.findings.filter((f) => f.severity === sev)
    return group.length ? `<h3 id="sev-${sev}">${label(sev)} (${group.length})</h3><ul class="findings">${group.map(finding).join('\n')}</ul>` : ''
  }).join('\n')
  const pages = r.pages.map((p) => `<tr><td>${link(p.url)}</td><td>${p.status ?? esc((p.error ?? 'error').replace(/_/g, ' '))}</td><td>${esc(p.title ?? '')}</td></tr>`).join('\n')
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${esc(`${r.run.runner.name} ${r.run.runner.version}`)}">
<title>Webtrax report: ${esc(host)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
<p class="brand">Webtrax</p>
<h1>Report for ${esc(target(r))}</h1>
<p class="muted">${esc(statusText(r))}${profileText(r) ? ` · ${esc(profileText(r)!)}` : ''} · ${esc(new Date(s.started_at).toUTCString())} · ${esc(durationText(r))}</p>
</header>
<main>
<section aria-labelledby="summary">
<h2 id="summary">Summary</h2>
<dl class="stats">${r.score.score === null ? '' : `
<div><dt>Health score</dt><dd>${r.score.score} <small>${r.score.grade}</small></dd></div>`}
<div><dt>Findings</dt><dd>${r.findings.length}</dd></div>
<div><dt>Pages crawled</dt><dd>${s.pages.crawled}</dd></div>
<div><dt>Links checked</dt><dd>${s.links.checked}</dd></div>
<div><dt>Broken links</dt><dd>${s.links.broken}</dd></div>
</dl>
${caveatText(s) ? `<p><strong>Not the whole picture.</strong> ${esc(caveatText(s)!)}</p>\n` : ''}<p>${esc(countsText(r.counts))}.${r.score.score === null ? '' : ' <a href="https://docs.webtrax.dev/health-score/">How the health score is worked out</a>.'}</p>
</section>
<section aria-labelledby="findings">
<h2 id="findings">Findings</h2>
${findings || '<p>No findings.</p>'}
</section>
${speedSection(r)}<section aria-labelledby="pages">
<h2 id="pages">Pages</h2>
<table>
<caption>${r.pages.length} URL${r.pages.length === 1 ? '' : 's'} fetched by the crawl</caption>
<thead><tr><th scope="col">URL</th><th scope="col">Status</th><th scope="col">Title</th></tr></thead>
<tbody>
${pages}
</tbody>
</table>
</section>
</main>
<footer class="muted">
<p>Generated by ${esc(r.run.runner.name)} ${esc(r.run.runner.version)}, crawling as <code>${esc(r.run.user_agent)}</code>. Suites: ${esc(s.suites.map((x) => `${x.id} ${x.version}`).join(', ') || 'none')}.</p>
</footer>
</body>
</html>
`
}
