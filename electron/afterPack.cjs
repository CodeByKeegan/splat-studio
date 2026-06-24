// Embeds the Windows app-exe icon + metadata using the standalone rcedit binary.
// electron-builder's own executable editing is disabled (signAndEditExecutable:
// false) because it requires winCodeSign, whose archive contains macOS symlinks
// that fail to extract on Windows without elevated privilege. rcedit ships its
// own .exe in the npm tarball, so this needs no download and no privilege.
const path = require('node:path');

module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') return;
    const rcedit = require('rcedit');
    const productName = context.packager.appInfo.productFilename; // "Splat Studio"
    const exe = path.join(context.appOutDir, `${productName}.exe`);
    const icon = path.join(context.packager.info.projectDir, 'build', 'icon.ico');
    await rcedit(exe, {
        icon,
        'version-string': {
            ProductName: 'Splat Studio',
            FileDescription: 'Splat Studio',
            CompanyName: 'CodeByKeegan',
            LegalCopyright: 'CodeByKeegan'
        }
    });
    console.log(`  • afterPack: set icon on ${path.basename(exe)}`);
};
