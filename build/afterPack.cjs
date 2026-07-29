// =====================================================================
// afterPack.cjs — give the bundle a VALID ad-hoc signature.
//
// Why this exists. `mac.identity: null` tells electron-builder to skip signing
// altogether. That does not leave the app unsigned-but-fine: it leaves
// Electron's own signature in place over a bundle we have since renamed and
// repacked, so the signature no longer matches its contents. macOS reports
//
//     code has no resources but signature indicates they must be present
//
// and on Apple Silicon a bundle whose signature does not verify is not
// permitted to run AT ALL — not "warned about", not "right-click to open".
// It dies on launch with no dialog and no log. The first dmg we built had
// exactly this defect and would have failed for every recipient.
//
// So: strip extended attributes (codesign refuses to sign a bundle carrying
// "resource fork, Finder information, or similar detritus" — the quarantine
// and provenance xattrs macOS adds are enough to trip it), then ad-hoc sign.
//
// This does NOT make the app notarized. A recipient who downloads it still has
// to allow it explicitly in Privacy & Security. What it buys is that the app is
// *capable* of running once they do — which without this it is not.
// =====================================================================

const { execFileSync } = require('node:child_process');
const { rmSync, renameSync } = require('node:fs');
const { join } = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const tmp = join(context.appOutDir, '.signing.app');
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });

  // The bundle must be REBUILT, not merely stripped. `xattr -cr` in place does
  // not reliably clear com.apple.FinderInfo from every nested helper, and
  // com.apple.provenance cannot be removed at all — codesign then refuses the
  // whole bundle over "detritus" in a subcomponent. ditto writes fresh files
  // without FinderInfo; the provenance the OS re-adds is tolerated.
  rmSync(tmp, { recursive: true, force: true });
  run('ditto', ['--norsrc', '--noextattr', '--noacl', app, tmp]);
  run('codesign', ['--force', '--deep', '--sign', '-', tmp]);
  run('codesign', ['--verify', '--strict', tmp]);   // verify BEFORE swapping in

  // rename, not copy: a copy would rewrite every file and could reintroduce
  // exactly the attributes we just went to the trouble of shedding.
  rmSync(app, { recursive: true, force: true });
  renameSync(tmp, app);

  // Verify, and FAIL THE BUILD if it did not take. A build that silently emits
  // an unlaunchable app is worse than one that stops: the defect surfaces on
  // someone else's machine, days later, as "it doesn't open" with nothing to
  // go on.
  try {
    run('codesign', ['--verify', '--strict', app]);
  } catch (e) {
    throw new Error(`afterPack: ad-hoc signature did not verify for ${app}\n${e.stderr ?? e}`);
  }
  console.log(`  • ad-hoc signed + verified  ${app}`);
};
