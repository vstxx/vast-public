import type { ExtensionPermissionSnapshot } from '../../src/shared/extension-marketplace.ts'
import { escapeHtml, type HubSession } from './security.ts'

export interface CatalogViewItem {
  id: string
  slug: string
  name: string
  summary: string
  publisherName: string
  category: string
  kind: string
  version: string
  downloads: number
  dataPractice: 'local-only' | 'external-processing' | 'undisclosed'
  privacyPolicyUrl?: string
  remoteServices: string
  iconUrl?: string
}

type PageSection = 'publishers' | 'explore' | 'dashboard' | 'review'

function page(title: string, content: string, session?: HubSession, active: PageSection = 'publishers'): string {
  const navItem = (href: string, label: string, key: string): string => `<a class="nav-item${active === key ? ' is-active' : ''}" href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`
  const reviewNavigation = session && session.publisher.role !== 'publisher' ? `${navItem('/review', 'Review', 'review')}<a class="nav-item" href="/review/reports">Reports</a>` : ''
  const leftNavigation = `${navItem('/', 'Publishers', 'publishers')}${navItem('/explore', 'Catalog', 'explore')}${session ? navItem('/dashboard', 'Dashboard', 'dashboard') : ''}${reviewNavigation}`
  const account = session
    ? `<a class="account-pill" href="/dashboard"><span class="account-pill__status" aria-hidden="true"></span><span>${escapeHtml(session.publisher.publisherName)}</span></a><button class="nav-item nav-item--button" data-action="logout" data-url="/auth/logout">Sign out</button>`
    : '<a class="nav-item nav-item--signin" href="/auth/github/start">Sign in with GitHub</a>'

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="theme-color" content="#060608">
    <title>${escapeHtml(title)} · Vast Publishers</title>
    <link rel="icon" href="/vast-extensions.png" type="image/png">
    <link rel="preload" href="/InterDisplay-Regular.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/styles.css">
    <script src="/app.js" defer></script>
  </head>
  <body>
    <div class="site-shell">
      <header class="topbar">
        <div class="topbar__inner">
          <nav class="topbar__nav" aria-label="Primary navigation">${leftNavigation}</nav>
          <a class="brand" href="/" aria-label="Vast Extensions for Publishers home"><img class="brand__image" src="/vast-extensions-for-publishers.png" alt="Vast Extensions for Publishers"></a>
          <nav class="topbar__nav topbar__nav--right" aria-label="Publisher account">${account}</nav>
        </div>
      </header>
      <main class="wrap">${content}</main>
      <footer class="footer"><div class="footer__inner"><span class="footer__copyright">Vast-owned source is MIT licensed. Publisher extensions remain their owners' property.</span><nav class="footer__links" aria-label="Legal and documentation"><a href="https://docs.vastbrowser.com/extensions/extension-development/" rel="noreferrer">Documentation</a><a href="https://vastbrowser.com/legal" rel="noreferrer">Legal information</a><a href="/legal/privacy">Privacy</a><a href="/legal/copyright">Copyright/IP</a><a href="/legal/platform-terms">Platform Terms</a><a href="/legal/publisher-terms">Publisher Terms</a><a href="/legal/publishing-policy">Publishing Policy</a></nav></div></footer>
    </div>
  </body>
</html>`
}

export function publisherHomePage(session?: HubSession): string {
  const primaryAction = session
    ? '<a class="button primary button--large" href="/dashboard">Open publisher dashboard</a>'
    : '<a class="button primary button--large" href="/auth/github/start?return=%2Fdashboard">Start publishing with GitHub</a>'
  const secondaryAction = session && session.publisher.role !== 'publisher'
    ? '<a class="button button--quiet button--large" href="/review">Open release review</a>'
    : '<a class="button button--quiet button--large" href="/explore">Browse the catalog</a>'
  return page('Publisher Platform', `<section class="publisher-hero">
    <div class="publisher-hero__copy"><h1>Build for Vast.<br><span>Publish to Explore.</span></h1><p>Create, submit, and manage extensions for Vast from one publisher workspace.</p><div class="publisher-hero__actions">${primaryAction}${secondaryAction}</div></div>
  </section>
  <nav class="publisher-resources" aria-label="Publisher resources"><a href="https://docs.vastbrowser.com/extensions/extension-development/" rel="noreferrer"><span>Documentation</span><span aria-hidden="true">&nearr;</span></a><a href="/explore"><span>Explore the catalog</span><span aria-hidden="true">&rarr;</span></a></nav>`, session, 'publishers')
}

function card(item: CatalogViewItem): string {
  const icon = item.iconUrl
    ? `<img class="extension-icon__image" src="${escapeHtml(item.iconUrl)}" alt="" loading="lazy">`
    : `<span class="extension-icon__letter">${escapeHtml(item.name.slice(0, 1).toUpperCase())}</span>`
  return `<article class="card">
    <div class="card__top"><span class="extension-icon">${icon}</span><div class="card__badges"><span class="badge">${escapeHtml(item.kind)}</span><span class="badge badge--quiet">${escapeHtml(item.category)}</span></div></div>
    <div class="card__body"><h2><a href="/extension/${escapeHtml(item.id)}">${escapeHtml(item.name)}</a></h2><p class="muted">${escapeHtml(item.summary)}</p></div>
    <div class="card__meta"><span>By ${escapeHtml(item.publisherName)}</span><span>v${escapeHtml(item.version)}</span><span>${item.downloads.toLocaleString('en-US')} downloads</span></div>
    <div class="card__actions"><a class="button button--quiet" href="/extension/${escapeHtml(item.id)}">Details</a><button class="button primary" data-action="install" data-id="${escapeHtml(item.id)}">Open in Vast</button></div>
  </article>`
}

export function homePage(items: CatalogViewItem[], query: string, categories: string[], session?: HubSession, selectedCategory = ''): string {
  const allHref = query ? `/explore?query=${encodeURIComponent(query)}` : '/explore'
  const categoryLinks = [`<a class="category-chip${selectedCategory ? '' : ' is-active'}" href="${allHref}">All</a>`, ...categories.map((category) => `<a class="category-chip${selectedCategory === category ? ' is-active' : ''}" href="/explore?category=${encodeURIComponent(category)}${query ? `&query=${encodeURIComponent(query)}` : ''}">${escapeHtml(category)}</a>`)].join('')
  const filtered = Boolean(query || selectedCategory)
  const emptyTitle = filtered ? 'Nothing matched this search.' : 'The catalog is ready.'
  const emptyCopy = filtered ? 'Try another phrase or clear the selected category.' : 'Reviewed extensions will appear here as soon as their first release is published.'
  const body = `<section class="hero hero--catalog">
    <h1>Make Vast yours.</h1>
    <p class="hero__copy">Reviewed extensions, built for Vast and designed to stay out of your way.</p>
    <form class="search" method="get">
      <label class="search__field"><span class="sr-only">Search extensions</span><input name="query" maxlength="128" value="${escapeHtml(query)}" aria-label="Search extensions" placeholder="Search extensions by name or publisher" autocomplete="off"></label>
      ${selectedCategory ? `<input type="hidden" name="category" value="${escapeHtml(selectedCategory)}">` : ''}
      <button class="button primary" type="submit">Search</button>
    </form>
    <nav class="category-list" aria-label="Extension categories">${categoryLinks}</nav>
  </section>
  ${items.length ? `<section class="catalog-section"><div class="section-heading"><div><h2>${filtered ? 'Search results' : 'Featured extensions'}</h2></div><span class="result-count">${items.length} ${items.length === 1 ? 'extension' : 'extensions'}</span></div><div class="grid">${items.map(card).join('')}</div></section>` : `<section class="empty-state"><span class="empty-state__mark" aria-hidden="true"></span><div><h2>${emptyTitle}</h2><p>${emptyCopy}</p></div>${filtered ? '<a class="button button--quiet" href="/explore">Clear filters</a>' : ''}</section>`}`
  return page('Extension catalog', body, session, 'explore')
}

export function detailPage(item: CatalogViewItem & { description: string; homepage?: string; sourceUrl?: string; permissions: ExtensionPermissionSnapshot }, session?: HubSession): string {
  const permissions = [...item.permissions.chrome, ...item.permissions.hosts, ...item.permissions.vast]
  const icon = item.iconUrl ? `<img class="extension-icon__image" src="${escapeHtml(item.iconUrl)}" alt="">` : `<span class="extension-icon__letter">${escapeHtml(item.name.slice(0, 1).toUpperCase())}</span>`
  return page(item.name, `<a class="breadcrumb" href="/explore"><span aria-hidden="true">←</span> Extension catalog</a>
    <section class="detail-hero">
      <div class="detail-hero__identity"><span class="extension-icon extension-icon--large">${icon}</span><div><h1>${escapeHtml(item.name)}</h1><p class="hero__copy">${escapeHtml(item.description)}</p><div class="detail-meta"><span>Published by ${escapeHtml(item.publisherName)}</span><span>Version ${escapeHtml(item.version)}</span><span>${item.downloads.toLocaleString('en-US')} downloads</span></div></div></div>
      <aside class="install-panel"><span class="install-panel__label">Ready for Vast</span><button class="button primary button--wide" data-action="install" data-id="${escapeHtml(item.id)}">Install extension</button><p>Vast will show the requested permissions before installation.</p></aside>
    </section>
    <section class="detail-grid"><article class="panel panel--content"><div class="panel__heading"><h2>Requested permissions</h2></div><div class="permissions">${permissions.length ? permissions.map((permission) => `<span>${escapeHtml(permission)}</span>`).join('') : '<span>No additional permissions</span>'}</div></article><article class="panel panel--content"><div class="panel__heading"><h2>Data practices</h2></div><p>${item.dataPractice === 'local-only' ? 'The publisher declares that this extension processes data only on the device and does not send it to external services.' : item.dataPractice === 'external-processing' ? 'The publisher declares that this extension sends data to or processes data with external services.' : 'No current data-practice declaration is available for this legacy listing.'}</p>${item.remoteServices ? `<p><strong>Remote services:</strong> ${escapeHtml(item.remoteServices)}</p>` : ''}${item.privacyPolicyUrl ? `<a class="resource-link" rel="noreferrer" href="${escapeHtml(item.privacyPolicyUrl)}"><span>Publisher privacy policy</span><span aria-hidden="true">&nearr;</span></a>` : ''}</article><article class="panel panel--content"><div class="panel__heading"><h2>Extension resources</h2></div><div class="resource-links">${item.homepage ? `<a class="resource-link" rel="noreferrer" href="${escapeHtml(item.homepage)}"><span>Homepage</span><span aria-hidden="true">&nearr;</span></a>` : ''}${item.sourceUrl ? `<a class="resource-link" rel="noreferrer" href="${escapeHtml(item.sourceUrl)}"><span>Source code</span><span aria-hidden="true">&nearr;</span></a>` : ''}${!item.homepage && !item.sourceUrl ? '<p class="muted">No external resources supplied.</p>' : ''}<a class="resource-link" href="/report/${escapeHtml(item.id)}"><span>Report extension</span><span aria-hidden="true">&rarr;</span></a></div></article></section>`, session, 'explore')
}

export interface DashboardExtension {
  id: string
  name: string
  slug: string
  status: string
  dataPractice: 'local-only' | 'external-processing' | 'undisclosed'
  privacyPolicyUrl?: string
  remoteServices: string
  releases: Array<{ id: string; version: string; status: string; createdAt: string }>
}

export function dashboardPage(extensions: DashboardExtension[], session: HubSession, categories: string[], termsAccepted: boolean): string {
  const options = categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('')
  const listings = extensions.map((extension) => {
    const releases = extension.releases.map((release) => `<div class="release"><div><strong>Version ${escapeHtml(release.version)}</strong><span class="release__date">${escapeHtml(release.createdAt)}</span></div><span class="badge badge--quiet">${escapeHtml(release.status)}</span>${release.status === 'draft' || release.status === 'changes' ? `<button class="button button--quiet" data-action="submit" data-url="/v1/publisher/releases/${escapeHtml(release.id)}/submit">Submit for review</button>` : ''}</div>`).join('')
    const localSelected = extension.dataPractice === 'local-only' ? ' selected' : ''
    const externalSelected = extension.dataPractice === 'external-processing' ? ' selected' : ''
    const undisclosedOption = extension.dataPractice === 'undisclosed' ? '<option value="" selected disabled>Select a declaration</option>' : ''
    return `<article class="panel listing-card">
      <div class="listing-card__header"><div><h2>${escapeHtml(extension.name)}</h2><p class="muted">/${escapeHtml(extension.slug)}</p></div><div class="listing-card__identity"><span class="badge">${escapeHtml(extension.status)}</span><code>${escapeHtml(extension.id)}</code></div></div>
      <form class="form-grid listing-data-form" data-extension-id="${escapeHtml(extension.id)}"><label class="field"><span>Data practices</span><select required name="dataPractice">${undisclosedOption}<option value="local-only"${localSelected}>Local processing only</option><option value="external-processing"${externalSelected}>External processing or transmission</option></select></label><label class="field"><span>Privacy policy URL <em>Required for external processing</em></span><input name="privacyPolicyUrl" type="url" value="${escapeHtml(extension.privacyPolicyUrl ?? '')}" placeholder="https://"></label><label class="field wide"><span>Remote services <em>Required for external processing</em></span><textarea name="remoteServices" maxlength="2000" placeholder="Name the services and explain why they are used.">${escapeHtml(extension.remoteServices)}</textarea></label><div class="form-actions wide"><span>Keep this declaration current when extension behavior changes.</span><button class="button button--quiet" type="submit"${termsAccepted ? '' : ' disabled'}>Save data practices</button></div></form>
      <div class="upload-grid">
        <form class="upload-form" data-extension-id="${escapeHtml(extension.id)}"><div class="upload-form__copy"><span class="upload-form__number">01</span><div><strong>Extension package</strong><span>Validated .vext release bundle</span></div></div><label class="file-field"><span class="sr-only">Upload .vext</span><input required name="package" type="file" accept=".vext,application/vnd.vast.extension+zip"></label><button class="button button--quiet" type="submit">Validate upload</button></form>
        <form class="upload-form media-upload-form" data-extension-id="${escapeHtml(extension.id)}" data-kind="icon"><div class="upload-form__copy"><span class="upload-form__number">02</span><div><strong>Catalog icon</strong><span>PNG, JPEG or WebP</span></div></div><label class="file-field"><span class="sr-only">Catalog icon</span><input required type="file" accept="image/png,image/jpeg,image/webp"></label><button class="button button--quiet" type="submit">Upload icon</button></form>
        <form class="upload-form media-upload-form" data-extension-id="${escapeHtml(extension.id)}" data-kind="screenshot"><div class="upload-form__copy"><span class="upload-form__number">03</span><div><strong>Screenshot</strong><span>Up to five catalog previews</span></div></div><label class="file-field"><span class="sr-only">Screenshot</span><input required type="file" accept="image/png,image/jpeg,image/webp"></label><button class="button button--quiet" type="submit">Add screenshot</button></form>
      </div>
      <div class="release-list"><div class="release-list__heading"><span>Releases</span><span>${extension.releases.length}</span></div>${releases || '<p class="status">No releases uploaded yet.</p>'}</div>
    </article>`
  }).join('')
  const verification = session.publisher.verified ? 'Verified publisher' : 'Publisher account'
  const workflowCopy = session.publisher.role === 'admin' ? 'Create stable listings, validate packages, then review and publish releases from the trusted admin workspace.' : 'Create stable listings, validate each package, and send releases through review.'
  return page('Publisher dashboard', `<section class="hero hero--workspace"><div><span class="eyebrow">Publisher dashboard</span><h1>${escapeHtml(session.publisher.publisherName)}</h1><p class="hero__copy">${workflowCopy}</p></div><div class="workspace-badge"><span class="workspace-badge__dot"></span><div><strong>${verification}</strong><span>${escapeHtml(session.publisher.role)}</span></div></div></section>
    ${termsAccepted ? '' : '<section class="panel panel--form"><div class="panel__heading"><h2>Publisher Terms required</h2><p>Review the current Publisher Terms before creating listings, uploading packages, or submitting releases.</p></div><form id="accept-terms-form"><label class="field"><span><input required name="accepted" type="checkbox" value="true"> I have read and accept the current Publisher Terms.</span></label><div class="form-actions"><a class="button button--quiet" href="/legal/publisher-terms">Read terms</a><button class="button primary" type="submit">Accept terms</button></div></form></section>'}
    <section class="panel panel--form"><div class="panel__heading"><h2>Create extension</h2><p>Start with the catalog identity. Release files are added after creation.</p></div><form id="create-extension-form" class="form-grid"><label class="field"><span>Name</span><input required name="name" maxlength="128" placeholder="Extension name"></label><label class="field"><span>Slug</span><input required name="slug" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxlength="64" placeholder="extension-name"></label><label class="field wide"><span>Extension ID <em>Optional for new projects</em></span><input name="extensionId" pattern="[a-p]{32}" minlength="32" maxlength="32" placeholder="32 letters from a to p" autocomplete="off"><small>Use the ID embedded in an existing .vext package. Leave blank to generate a new ID.</small></label><label class="field"><span>Summary</span><input required name="summary" maxlength="280" placeholder="A concise catalog description"></label><label class="field"><span>Category</span><select name="category">${options}</select></label><label class="field wide"><span>Description</span><textarea required name="description" maxlength="16000" placeholder="What does this extension add to Vast?"></textarea></label><label class="field"><span>Data practices</span><select name="dataPractice"><option value="local-only">Local processing only</option><option value="external-processing">External processing or transmission</option></select></label><label class="field"><span>Privacy policy URL <em>Required for external processing</em></span><input name="privacyPolicyUrl" type="url" placeholder="https://"></label><label class="field wide"><span>Remote services <em>Leave blank if none</em></span><textarea name="remoteServices" maxlength="2000" placeholder="Name the services and explain why they are used."></textarea></label><label class="field"><span>Homepage <em>Optional</em></span><input name="homepage" type="url" placeholder="https://"></label><label class="field"><span>Source URL <em>Optional</em></span><input name="sourceUrl" type="url" placeholder="https://github.com/"></label><div class="form-actions wide"><span>Fields can be edited before the first release is published.</span><button class="button primary" type="submit"${termsAccepted ? '' : ' disabled'}>Create listing</button></div></form></section>
    <section class="workspace-section"><div class="section-heading"><div><h2>Your extensions</h2></div><span class="result-count">${extensions.length} ${extensions.length === 1 ? 'listing' : 'listings'}</span></div>${listings || '<div class="empty-state"><span class="empty-state__mark" aria-hidden="true"></span><div><h2>No extension listings yet.</h2><p>Create your first listing above, then upload its release package.</p></div></div>'}</section>`, session, 'dashboard')
}

export interface ReviewItem {
  submissionId: string
  releaseId: string
  extensionId: string
  extensionName: string
  version: string
  publisherName: string
  submittedAt: string
  summary: string
  description: string
  sourceUrl?: string
  manifest: { name: string; description: string; kind: string }
  screenshots: string[]
  validation: string[]
  permissions: ExtensionPermissionSnapshot
  addedPermissions: string[]
  publisherId: string
}

export interface ExtensionReportReviewItem {
  id: string
  extensionName: string
  publisherName: string
  category: string
  details: string
  reporterName?: string
  reporterEmail?: string
  status: 'open' | 'reviewing'
  legalHold: boolean
  createdAt: string
}

export function reviewPage(items: ReviewItem[], session: HubSession): string {
  const queue = items.map((item) => {
    const permissions = [...item.permissions.chrome, ...item.permissions.hosts, ...item.permissions.vast]
    const ownedByReviewer = item.publisherId === session.publisher.id
    return `<article class="panel review-card"><div class="review-card__header"><div><div class="review-card__badges"><span class="badge">Pending review</span>${ownedByReviewer ? '<span class="badge">Separate reviewer required</span>' : ''}</div><h2>${escapeHtml(item.extensionName)} <span>${escapeHtml(item.version)}</span></h2><p class="meta">${escapeHtml(item.publisherName)} &middot; submitted ${escapeHtml(item.submittedAt)}</p></div><span class="review-card__id">${escapeHtml(item.submissionId)}</span></div>
      <div class="review-summary"><strong>${escapeHtml(item.summary)}</strong><p>${escapeHtml(item.description)}</p></div>
      <div class="review-grid"><div><h3>${escapeHtml(item.manifest.name)} · ${escapeHtml(item.manifest.kind)}</h3><p>${escapeHtml(item.manifest.description)}</p></div><div><h3>${item.validation.length} automated checks</h3><p>${item.validation.map(escapeHtml).join(', ') || 'No findings recorded.'}</p></div></div>
      <div class="review-resources">${item.sourceUrl ? `<a class="resource-link" rel="noreferrer" href="${escapeHtml(item.sourceUrl)}"><span>Inspect source</span><span aria-hidden="true">&nearr;</span></a>` : '<span class="status">No source URL supplied.</span>'}${item.screenshots.length ? item.screenshots.map((url, index) => `<a class="button button--quiet" rel="noreferrer" href="${escapeHtml(url)}">Screenshot ${index + 1}</a>`).join('') : '<span class="status">No screenshots supplied.</span>'}</div>
      <div class="review-permissions"><div><h3>Requested permissions</h3></div><div class="permissions">${permissions.map((permission) => `<span>${escapeHtml(permission)}</span>`).join('') || '<span>No additional permissions</span>'}</div><p>Added since the current release: ${item.addedPermissions.length ? item.addedPermissions.map(escapeHtml).join(', ') : 'none'}</p></div>
      <label class="field"><span>Reviewer note</span><textarea data-review-note="${escapeHtml(item.submissionId)}" maxlength="4000" placeholder="Add a concise note for the publisher"></textarea></label>
      ${ownedByReviewer ? '<p class="admin-review-note">This release belongs to your publisher identity. A different reviewer must handle it.</p>' : ''}<div class="review-actions"><button class="button primary" data-action="approve" data-review="${escapeHtml(item.submissionId)}" data-url="/v1/review/submissions/${escapeHtml(item.submissionId)}"${ownedByReviewer ? ' disabled' : ''}>Approve and sign</button><button class="button button--quiet" data-action="changes" data-review="${escapeHtml(item.submissionId)}" data-url="/v1/review/submissions/${escapeHtml(item.submissionId)}"${ownedByReviewer ? ' disabled' : ''}>Request changes</button><button class="button danger" data-action="reject" data-review="${escapeHtml(item.submissionId)}" data-url="/v1/review/submissions/${escapeHtml(item.submissionId)}"${ownedByReviewer ? ' disabled' : ''}>Reject</button></div>
    </article>`
  }).join('')
  return page('Review queue', `<section class="hero hero--workspace"><div><span class="eyebrow">Trusted release operations</span><h1>Release queue</h1><p class="hero__copy">Every approval revalidates the package, signs the official artifact, and publishes its descriptor atomically.</p></div><div class="workspace-badge"><span class="workspace-badge__dot"></span><div><strong>${items.length} pending</strong><span>Review workspace</span></div></div></section><section class="workspace-section">${queue || '<div class="empty-state"><span class="empty-state__mark empty-state__mark--clear" aria-hidden="true"></span><div><h2>The review queue is clear.</h2><p>New submissions will appear here after package validation.</p></div></div>'}</section>`, session, 'review')
}

export function messagePage(title: string, message: string, session?: HubSession): string {
  return page(title, `<section class="message-state"><span class="empty-state__mark" aria-hidden="true"></span><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><a class="button button--quiet" href="/">Back to Publisher Platform</a></section>`, session)
}

export function reportReviewPage(items: ExtensionReportReviewItem[], session: HubSession): string {
  const queue = items.map((item) => `<article class="panel review-card">
    <div class="review-card__header"><div><div class="review-card__badges"><span class="badge">${escapeHtml(item.category)}</span><span class="badge badge--quiet">${escapeHtml(item.status)}</span>${item.legalHold ? '<span class="badge badge--admin">Legal hold</span>' : ''}</div><h2>${escapeHtml(item.extensionName)}</h2><p class="meta">Published by ${escapeHtml(item.publisherName)} &middot; reported ${escapeHtml(item.createdAt)}</p></div><span class="review-card__id">${escapeHtml(item.id)}</span></div>
    <div class="review-summary"><p>${escapeHtml(item.details)}</p></div>
    <div class="review-grid"><div><h3>Reporter</h3><p>${escapeHtml(item.reporterName || 'Name not supplied')}</p><p>${escapeHtml(item.reporterEmail || 'Email not supplied')}</p></div><div><h3>Handling policy</h3><p>A report does not automatically delist an extension. Record an evidence-based decision and separately confirm any publisher notification.</p></div></div>
    <form class="report-review-form form-grid" data-report-id="${escapeHtml(item.id)}">
      <label class="field"><span>Decision</span><select required name="status"><option value="reviewing"${item.status === 'reviewing' ? ' selected' : ''}>Keep under review</option><option value="actioned">Actioned</option><option value="dismissed">Dismissed</option></select></label>
      <label class="field"><span>Evidence retention</span><span><input name="legalHold" type="checkbox" value="true"${item.legalHold ? ' checked' : ''}> Preserve report under legal hold</span></label>
      <label class="field wide"><span>Internal reason</span><textarea required name="reason" minlength="10" maxlength="4000" placeholder="Record the evidence reviewed and the reason for this decision."></textarea></label>
      <label class="field wide"><span><input name="publisherNotified" type="checkbox" value="true"> I confirm that the publisher has been notified outside the Hub</span></label>
      <div class="form-actions wide"><span>The action, reviewer, timestamp, legal-hold state, and notification confirmation are written to the audit trail.</span><button class="button primary" type="submit">Record decision</button></div>
    </form>
  </article>`).join('')
  return page('Extension reports', `<section class="hero hero--workspace"><div><span class="eyebrow">Trust and safety review</span><h1>Extension reports</h1><p class="hero__copy">Review abuse and rights reports without automatic delisting. Decisions and evidence-retention changes remain auditable.</p></div><div class="workspace-badge"><span class="workspace-badge__dot"></span><div><strong>${items.length} open</strong><span>Review workspace</span></div></div></section><section class="workspace-section">${queue || '<div class="empty-state"><span class="empty-state__mark empty-state__mark--clear" aria-hidden="true"></span><div><h2>No open reports.</h2><p>New reports will appear here for human review.</p></div></div>'}</section>`, session, 'review')
}

export function legalPage(title: string, paragraphs: string[], session?: HubSession): string {
  return page(title, `<section class="hero hero--workspace"><div><span class="eyebrow">Vast Extensions Hub</span><h1>${escapeHtml(title)}</h1></div></section><article class="panel panel--content">${paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('')}</article>`, session)
}

export function reportPage(item: CatalogViewItem, session?: HubSession): string {
  return page(`Report ${item.name}`, `<section class="hero hero--workspace"><div><span class="eyebrow">Trust and safety</span><h1>Report ${escapeHtml(item.name)}</h1><p class="hero__copy">Reports are reviewed by a person. Filing a report does not automatically remove the extension.</p></div></section><section class="panel panel--form"><form id="report-extension-form" class="form-grid" data-extension-id="${escapeHtml(item.id)}"><label class="field"><span>Category</span><select required name="category"><option value="copyright">Copyright or IP</option><option value="malware">Malware</option><option value="illegal">Illegal functionality</option><option value="privacy">Privacy abuse</option><option value="impersonation">Impersonation</option><option value="other">Other</option></select></label><label class="field"><span>Email <em>Optional</em></span><input name="reporterEmail" type="email" maxlength="254"></label><label class="field wide"><span>Details</span><textarea required name="details" minlength="20" maxlength="8000"></textarea></label><label class="field"><span>Name <em>Optional</em></span><input name="reporterName" maxlength="200"></label><div class="form-actions wide"><span>Do not include passwords, session tokens, or private school data.</span><button class="button primary" type="submit">Submit report</button></div></form></section>`, session, 'explore')
}
