'use strict';

// Ad-hoc code-sign the macOS app after electron-builder packs it (before the dmg
// is built). electron-builder 24 won't ad-hoc sign on its own without a real
// identity, which leaves Apple-Silicon downloads flagged as "damaged". An ad-hoc
// signature (`codesign --sign -`) makes the app a valid (if unidentified) binary,
// so Gatekeeper shows the milder "unidentified developer" prompt instead.

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
};
