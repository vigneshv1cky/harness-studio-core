/** Environment variable that carries the build version through one packaging and upload run. */
export const DESKTOP_BUILD_VERSION_ENV: 'DSH_DESKTOP_BUILD_VERSION'

/** Harness Studio: environment variable carrying the Harness Studio release a Studio build stamps on the app. */
export const STUDIO_VERSION_ENV: 'HARNESS_STUDIO_VERSION'

/**
 * Validate a build version against the product version it extends.
 * @param buildVersion - Version this build publishes.
 * @param productVersion - Version the manifests declare.
 * @returns The version as semver normalizes it, which is what the artifacts will carry.
 */
export function validateDesktopBuildVersion(buildVersion: string, productVersion: string): string

/**
 * Resolve the version a build publishes.
 * @param env - Packaging or upload environment.
 * @param productVersion - Version the manifests declare.
 * @returns The build version when one is present, otherwise the product version.
 */
export function resolveDesktopBuildVersion(env: NodeJS.ProcessEnv, productVersion: string): string

/**
 * Resolve the version the packaged app carries: the Harness Studio release when a Studio build supplies one, in
 * preference to any build version, otherwise the version this build publishes.
 * @param env - Packaging environment.
 * @param productVersion - Version the manifests declare.
 * @returns The app version electron-builder stamps on the app and its artifacts.
 */
export function resolveDesktopAppVersion(env: NodeJS.ProcessEnv, productVersion: string): string

/**
 * Everything a build version carries before its date, including the trailing separator.
 * @param productVersion - Version the manifests declare.
 * @returns The prefix shared by every build version of that product version.
 */
export function desktopBuildVersionPrefix(productVersion: string): string
