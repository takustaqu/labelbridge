// crates/labelbridge-wasm を wasm にして、src/core/wasm.gen.ts に埋め込む（base64）。
//   pnpm --filter @takustaqu/labelbridge wasm
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
execFileSync('cargo', ['build', '-p', 'labelbridge-wasm', '--profile', 'wasm', '--target', 'wasm32-unknown-unknown'], { cwd: root, stdio: 'inherit' })
const wasm = readFileSync(`${root}target/wasm32-unknown-unknown/wasm/labelbridge_wasm.wasm`)
const out = fileURLToPath(new URL('../src/core/wasm.gen.ts', import.meta.url))
writeFileSync(
  out,
  `// 生成ファイル（scripts/build-wasm.mjs）。手で直さない。元は crates/labelbridge-wasm\n` +
    `export const WASM_BASE64 =\n  '${wasm.toString('base64')}'\n`,
)
console.log(`${out}: ${wasm.length} bytes`)
