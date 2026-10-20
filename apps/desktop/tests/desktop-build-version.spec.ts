import { describe, expect, it } from 'vitest'
import {
  DESKTOP_BUILD_VERSION_ENV,
  STUDIO_VERSION_ENV,
  desktopBuildVersionPrefix,
  resolveDesktopAppVersion,
  resolveDesktopBuildVersion,
  validateDesktopBuildVersion,
} from '../scripts/desktop-build-version.mjs'

const PRERELEASE = '0.1.6-alpha.2'
const STABLE = '0.1.6'

describe('desktop build version', () => {
  it('publishes the product version when no build version is present', () => {
    expect(resolveDesktopBuildVersion({}, PRERELEASE)).toBe(PRERELEASE)
    expect(resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: '   ' }, PRERELEASE)).toBe(PRERELEASE)
  })

  it.each(['0.1.6-alpha.2.20260921.1', '0.1.6-alpha.2.20260921.12'])(
    'accepts %s, which outranks the prerelease base it extends', (buildVersion) => {
      expect(resolveDesktopBuildVersion({ [DESKTOP_BUILD_VERSION_ENV]: buildVersion }, PRERELEASE)).toBe(buildVersion)
      expect(validateDesktopBuildVersion(buildVersion, PRERELEASE)).toBe(buildVersion)
    })

  it('accepts the documented test form on a stable base', () => {
    // 0.1.6-test.x ranks below 0.1.6, which is why this form only ever reaches a test feed.
    expect(validateDesktopBuildVersion('0.1.6-test.20260921.1', STABLE)).toBe('0.1.6-test.20260921.1')
  })

  it.each([PRERELEASE, STABLE])('accepts %s, the product version itself', (productVersion) => {
    expect(validateDesktopBuildVersion(productVersion, productVersion)).toBe(productVersion)
  })

  it.each(['', 'nightly', '0.1.6-alpha.2.'])(
    'rejects %j as a version', (buildVersion) => {
      expect(() => validateDesktopBuildVersion(buildVersion, PRERELEASE)).toThrow(/is not a version/u)
    })

  it('normalizes what the artifacts carry, so validation and publication agree', () => {
    expect(validateDesktopBuildVersion('v0.1.6-alpha.2.1', PRERELEASE)).toBe('0.1.6-alpha.2.1')
  })

  it('rejects build metadata, which does not affect updater precedence', () => {
    expect(() => validateDesktopBuildVersion('0.1.6-alpha.2.1+build', PRERELEASE)).toThrow(/build metadata/u)
  })

  it.each(['0.1.7-alpha.2.20260921.1', '0.2.6-alpha.2.20260921.1'])(
    'rejects %s because it leaves the product release numbers', (buildVersion) => {
      expect(() => validateDesktopBuildVersion(buildVersion, PRERELEASE)).toThrow(/must extend product version/u)
    })

  it.each(['0.1.6-beta.2.20260921.1', '0.1.6-alpha.3', '0.1.6'])(
    'rejects %s because it does not extend the product prerelease', (buildVersion) => {
      expect(() => validateDesktopBuildVersion(buildVersion, PRERELEASE)).toThrow(/must extend 0\.1\.6-alpha\.2 as/u)
    })

  it.each(['0.1.6-20260921.1', '0.1.6-nightly.20260921.1'])(
    'rejects %s on a stable base, which the test form has to open', (buildVersion) => {
      expect(() => validateDesktopBuildVersion(buildVersion, STABLE)).toThrow(/must extend 0\.1\.6 as 0\.1\.6-test\./u)
    })

  it.each([[PRERELEASE, '0.1.6-alpha.2.'], [STABLE, '0.1.6-test.']])(
    'opens %s build versions with %s', (productVersion, prefix) => {
      expect(desktopBuildVersionPrefix(productVersion)).toBe(prefix)
    })

  it('stamps a Harness Studio release on the app in place of the product version', () => {
    expect(resolveDesktopAppVersion({}, PRERELEASE)).toBe(PRERELEASE)
    expect(resolveDesktopAppVersion({ [DESKTOP_BUILD_VERSION_ENV]: '0.1.6-alpha.2.20260921.1' }, PRERELEASE))
      .toBe('0.1.6-alpha.2.20260921.1')
    expect(resolveDesktopAppVersion({ [STUDIO_VERSION_ENV]: '0.3.2' }, PRERELEASE)).toBe('0.3.2')
    expect(() => resolveDesktopAppVersion({ [STUDIO_VERSION_ENV]: '0.3.2+1' }, PRERELEASE)).toThrow(/build metadata/u)
    expect(() => resolveDesktopAppVersion({ [STUDIO_VERSION_ENV]: 'latest' }, PRERELEASE)).toThrow(/is not a version/u)
    // Packaging always sets the build version, so the Studio release takes precedence over it.
    expect(resolveDesktopAppVersion({ [STUDIO_VERSION_ENV]: '0.3.2', [DESKTOP_BUILD_VERSION_ENV]: PRERELEASE }, PRERELEASE))
      .toBe('0.3.2')
  })
})
