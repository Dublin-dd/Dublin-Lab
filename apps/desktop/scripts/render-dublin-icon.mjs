/** Convert Dublin's original portrait into the native and web application icon sizes. */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const resources = fileURLToPath(new URL('../resources/', import.meta.url))
const source = join(resources, 'dublin-avatar.png')
const temporary = mkdtempSync(join(tmpdir(), 'dublin-icon-'))
const iconset = join(temporary, 'dublin.iconset')
try {
  mkdirSync(iconset)
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const edge = size * scale
      await sharp(source).resize(edge, edge).png().toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`))
    }
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', join(resources, 'dublin.icns'), iconset])
  for (const target of ['dublin.png', 'icon.png', 'icon-macos.png', 'icon-windows.png']) {
    await sharp(source).resize(1024, 1024).png().toFile(join(resources, target))
  }
  for (const target of [
    new URL('../renderer/assets/dublin-icon.png', import.meta.url),
    new URL('../../web/public/assets/dublin-icon.png', import.meta.url),
  ]) {
    const path = fileURLToPath(target)
    mkdirSync(dirname(path), { recursive: true })
    await sharp(source).resize(512, 512).png().toFile(path)
  }
  console.log('Dublin Lab: rendered macOS and web application icons')
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
