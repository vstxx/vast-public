const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const browserPolicy = JSON.parse(readFileSync(join(__dirname, 'store-browser-policy.json'), 'utf8'))
const STORE_POLICY_REVIEWED_AT = browserPolicy.reviewedAt
const STORE_POLICY_REVIEW_MAX_AGE_DAYS = browserPolicy.maximumReviewAgeDays
const STORE_APP_ID = 'Vast'
const STORE_DISPLAY_NAME = 'Vast Browser'

function xml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function msixVersionForSemver(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(version))
  if (!match) throw new Error(`MSIX packaging requires a stable x.y.z version; received ${version}.`)
  // Package 1.2.7.0 was consumed by the rejected Electron 44.0.0 Store
  // submission. Keep the Store-reserved fourth component at zero while using
  // a monotonic patch offset so rebuilt 0.2.7 packages have a unique identity.
  const values = [Number(match[1]) + 1, Number(match[2]), Number(match[3]) + 1, 0]
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 65535)) {
    throw new Error(`Version ${version} cannot be represented as a four-part MSIX version.`)
  }
  return values.join('.')
}

function requiredEnv(env, name) {
  const value = String(env[name] ?? '').trim()
  if (!value) throw new Error(`${name} is required for a production Microsoft Store package.`)
  return value
}

function validateIdentityName(value) {
  if (value.length > 50 || !/^[A-Za-z0-9.-]+$/.test(value)) {
    throw new Error('VAST_MSIX_IDENTITY_NAME must be the exact Partner Center identity name (1-50 ASCII letters, digits, periods or hyphens).')
  }
  return value
}

function validatePublisher(value) {
  if (value.length > 8192 || !/^(?:CN|O|OU|L|S|C|STREET|DC|UID)=/i.test(value)) {
    throw new Error('VAST_MSIX_PUBLISHER must be the exact distinguished publisher name from Partner Center.')
  }
  return value
}

function identityFromEnv(env = process.env, development = false) {
  const identity = development
    ? {
        name: 'VastBrowser.Development',
        publisher: 'CN=Vast Browser Development',
        publisherDisplayName: 'Vast Browser Development'
      }
    : {
        name: requiredEnv(env, 'VAST_MSIX_IDENTITY_NAME'),
        publisher: requiredEnv(env, 'VAST_MSIX_PUBLISHER'),
        publisherDisplayName: requiredEnv(env, 'VAST_MSIX_PUBLISHER_DISPLAY_NAME')
      }
  return {
    name: validateIdentityName(identity.name),
    publisher: validatePublisher(identity.publisher),
    publisherDisplayName: identity.publisherDisplayName.slice(0, 256)
  }
}

function manifestXml(identity, version = pkg.version) {
  const packageVersion = msixVersionForSemver(version)
  return `<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="${xml(identity.name)}" Publisher="${xml(identity.publisher)}" Version="${packageVersion}" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>${STORE_DISPLAY_NAME}</DisplayName>
    <PublisherDisplayName>${xml(identity.publisherDisplayName)}</PublisherDisplayName>
    <Description>Vast Browser</Description>
    <Logo>Assets\\StoreLogo.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Applications>
    <Application Id="${STORE_APP_ID}" Executable="Vast.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements
        DisplayName="${STORE_DISPLAY_NAME}"
        Description="Vast Browser"
        BackgroundColor="transparent"
        Square44x44Logo="Assets\\Square44x44Logo.png"
        Square150x150Logo="Assets\\Square150x150Logo.png">
        <uap:DefaultTile
          ShortName="Vast"
          Wide310x150Logo="Assets\\Wide310x150Logo.png"
          Square310x310Logo="Assets\\Square310x310Logo.png" />
      </uap:VisualElements>
      <Extensions>
        <uap:Extension Category="windows.protocol"><uap:Protocol Name="vast" /></uap:Extension>
        <uap:Extension Category="windows.protocol"><uap:Protocol Name="http" /></uap:Extension>
        <uap:Extension Category="windows.protocol"><uap:Protocol Name="https" /></uap:Extension>
        <uap:Extension Category="windows.fileTypeAssociation">
          <uap:FileTypeAssociation Name="vastpdf">
            <uap:DisplayName>PDF Document</uap:DisplayName>
            <uap:SupportedFileTypes><uap:FileType>.pdf</uap:FileType></uap:SupportedFileTypes>
          </uap:FileTypeAssociation>
        </uap:Extension>
      </Extensions>
    </Application>
  </Applications>
  <Capabilities>
    <Capability Name="internetClient" />
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
`
}

module.exports = {
  STORE_APP_ID,
  STORE_DISPLAY_NAME,
  STORE_POLICY_REVIEWED_AT,
  STORE_POLICY_REVIEW_MAX_AGE_DAYS,
  identityFromEnv,
  manifestXml,
  msixVersionForSemver,
  packageVersion: pkg.version,
  root
}
