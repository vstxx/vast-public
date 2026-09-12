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

function storePackageVersion(env = process.env) {
  const config = require('./release-config.json')
  const version = env.VAST_MSIX_PACKAGE_VERSION || config.storePackageVersion
  const previous = env.VAST_MSIX_PREVIOUS_PACKAGE_VERSION || config.previousStorePackageVersion
  const parse = (value) => {
    if (!/^[1-9]\d*\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$/.test(value) || value.split('.').some((part) => Number(part) > 65535)) {
      throw new Error(`Invalid Store package version ${value}; use four components, first > 0, each <= 65535, fourth = 0.`)
    }
    return value.split('.').map(Number)
  }
  const currentParts = parse(version)
  const previousParts = parse(previous)
  const difference = currentParts.map((part, index) => part - previousParts[index]).find((part) => part !== 0) || 0
  if (difference <= 0) throw new Error(`Store package version ${version} must be greater than previously consumed ${previous}. Set VAST_MSIX_PACKAGE_VERSION and VAST_MSIX_PREVIOUS_PACKAGE_VERSION from Partner Center.`)
  return version
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

function manifestXml(identity, env = process.env) {
  const packageVersion = storePackageVersion(env)
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
  storePackageVersion,
  packageVersion: pkg.version,
  root
}
