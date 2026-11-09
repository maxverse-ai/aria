import pkg from '../../package.json';
declare const ARIA_BUILD_COMMIT: string;
export const runtimeBuildIdentity = {
  version: pkg.version,
  commit: typeof ARIA_BUILD_COMMIT === 'string' ? ARIA_BUILD_COMMIT : 'development',
};
