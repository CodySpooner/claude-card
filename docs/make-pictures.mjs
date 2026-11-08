// Draws the README's and the website's pictures from the real card page, and rebuilds docs/demo.html:
//   node docs/make-pictures.mjs          every picture
//   node docs/make-pictures.mjs hero     just one
// It needs Node 24, Chrome or Edge, and ffmpeg. Set CHROME if neither browser is in the usual place.
// The social card also has to be uploaded by hand: Settings, General, Social preview.
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DOCS = resolve(fileURLToPath(import.meta.url), '..')
const IMAGES = join(DOCS, 'images')
const TEMP = mkdtempSync(join(tmpdir(), 'make-pictures-'))
const IDS = ['phosphor', 'prism', 'obsidian', 'horizon', 'volt']
const LOOP = { seconds: 6, fps: 15 }
const PICTURES = {
  hero: { file: 'hero.webp', width: 1280, height: 520, ...LOOP },
  ...Object.fromEntries(IDS.map(id => [id, { file: `${id}.webp`, width: 440, height: 540, ...LOOP }])),
  ...Object.fromEntries(IDS.map(id => [`card-${id}`, { file: `card-${id}.webp`, width: 620, height: 860, clear: true }])),
  viewer: { file: 'viewer.jpg', width: 1180, height: 900 },
  social: { file: 'social-preview.png', width: 1280, height: 640 },
  sample: { file: 'sample.jpg' }, // not staged: this one presses the real Download button
}
const browser = process.env.CHROME ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome'].find(existsSync)

// The sample card, built the way /card builds one. The config folder is a temporary one, so your own stats stay out of it.
execFileSync(process.execPath, [join(DOCS, '..', 'card.mjs'), '--demo', '--no-open'], { env: { ...process.env, CLAUDE_CONFIG_DIR: TEMP }, stdio: 'ignore' })
copyFileSync(join(TEMP, 'claude-card', 'demo.html'), join(DOCS, 'demo.html'))

// showcase.html reaches into its frames to pose the cards, which file:// pages aren't allowed to do.
const TYPES = { '.html': 'text/html', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' }
const server = createServer((request, response) => {
  const path = join(DOCS, new URL(request.url, 'http://x').pathname)
  if (!existsSync(path) || statSync(path).isDirectory()) return response.writeHead(404).end()
  response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(readFileSync(path))
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const BASE = `http://127.0.0.1:${server.address().port}`

const chrome = spawn(browser, ['--headless=new', '--hide-scrollbars', '--force-color-profile=srgb', '--remote-debugging-port=0', `--user-data-dir=${join(TEMP, 'profile')}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
const address = await new Promise(done => {
  let text = ''
  chrome.stderr.on('data', part => {
    text += part
    const found = text.match(/ws:\/\/\S+/)
    if (found) done(found[0])
  })
})
const socket = new WebSocket(address)
await new Promise(done => { socket.onopen = done })
const waiting = new Map()
let nextId = 1
socket.onmessage = event => {
  const reply = JSON.parse(event.data)
  if (!waiting.has(reply.id)) return
  const { done, fail } = waiting.get(reply.id)
  waiting.delete(reply.id)
  if (reply.error) fail(new Error(reply.error.message))
  else done(reply.result)
}
const send = (method, params = {}, sessionId) => new Promise((done, fail) => {
  const id = nextId++
  waiting.set(id, { done, fail })
  socket.send(JSON.stringify({ id, method, params, sessionId }))
})

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const page = (method, params) => send(method, params, sessionId)
await page('Page.enable')
const evaluate = async expression => {
  const { result, exceptionDetails } = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}
const sleep = ms => new Promise(done => setTimeout(done, ms))

const report = path => console.log(`${String(statSync(path).size).padStart(9)}  docs/images/${path.split(/[\\/]/).pop()}`)
const ffmpeg = (...args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args])
mkdirSync(IMAGES, { recursive: true })

async function draw(name, { file, width, height, seconds, fps, clear }) {
  await page('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  if (clear) await page('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
  await page('Page.navigate', { url: `${BASE}/showcase.html?scene=${name}` })
  for (let tries = 0; !(await evaluate('typeof window.ready === "object"')); tries++) {
    if (tries > 200) throw new Error(`${name} never started`)
    await sleep(50)
  }
  await evaluate('window.ready')
  const out = join(IMAGES, file)
  if (!seconds) {
    await evaluate('seek(0)')
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    const png = join(TEMP, `${name}.png`)
    writeFileSync(png, Buffer.from(data, 'base64'))
    if (clear) await page('Emulation.setDefaultBackgroundColorOverride', {})
    if (file.endsWith('.png')) copyFileSync(png, out)
    else if (file.endsWith('.jpg')) ffmpeg('-i', png, '-q:v', '3', out)
    else ffmpeg('-i', png, '-c:v', 'libwebp', '-quality', '88', out)
    return report(out)
  }
  const frames = join(TEMP, name)
  mkdirSync(frames)
  const count = Math.round(seconds * fps)
  for (let i = 0; i < count; i++) {
    await evaluate(`seek(${i / fps}, ${seconds})`)
    const { data } = await page('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(frames, `${String(i).padStart(4, '0')}.png`), Buffer.from(data, 'base64'))
  }
  ffmpeg('-framerate', String(fps), '-i', join(frames, '%04d.png'), '-c:v', 'libwebp_anim', '-loop', '0', '-quality', '55', '-compression_level', '6', out)
  report(out)
}

// Opens the sample card as a local file, the way /card does, presses Download, and fails if no PNG arrives.
async function sample({ file }) {
  const folder = join(TEMP, 'downloads')
  mkdirSync(folder)
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: folder })
  await page('Emulation.setDeviceMetricsOverride', { width: 1100, height: 900, deviceScaleFactor: 1, mobile: false })
  await page('Page.navigate', { url: `${pathToFileURL(join(DOCS, 'demo.html')).href}#prism` })
  await sleep(1000)
  await evaluate('document.fonts.ready.then(() => { intro = -1e9; drag = { x: 0, y: 0 }; ry = -18; rx = 7; pose(); document.querySelector("#save").click() })')
  let saved
  for (let tries = 0; !saved; tries++) {
    if (tries > 200) throw new Error(`Download never arrived. The page says: ${await evaluate('document.querySelector(".toast").textContent')}`)
    await sleep(100)
    saved = readdirSync(folder).find(name => name.endsWith('.png'))
  }
  const bytes = readFileSync(join(folder, saved))
  if (bytes.toString('latin1', 1, 4) !== 'PNG' || bytes.length < 100_000) throw new Error(`${saved} isn't a real picture`)
  console.log(`Download works: ${saved}, ${Math.round(bytes.length / 1024)} KB`)
  const out = join(IMAGES, file)
  ffmpeg('-i', join(folder, saved), '-vf', 'scale=960:-1', '-q:v', '3', out)
  report(out)
}

const wanted = process.argv.slice(2)
try {
  for (const [name, picture] of Object.entries(PICTURES)) {
    if (wanted.length && !wanted.includes(name)) continue
    if (name === 'sample') await sample(picture)
    else await draw(name, picture)
  }
} finally {
  socket.close()
  chrome.kill()
  server.close()
  await sleep(500) // The browser lets go of its profile folder.
  rmSync(TEMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
