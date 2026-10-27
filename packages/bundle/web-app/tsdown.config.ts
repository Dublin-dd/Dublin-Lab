import { defineConfig } from 'tsdown'
import { typertPlugin } from '../../typert/generator/lib/types/tsdown-plugin.js'

/**
 * Host bundle for the web surface. Entry points are the tsc emit, so the
 * AIPM product route in src/ is included after `tsc -b`. Workspace source
 * dependencies require the same decorator lowering as the root Host build.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/startup.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [typertPlugin({ mode: 'package', faces: ['host'] })],
})
