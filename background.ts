chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "captureScreenshot") {
    // 立即响应，避免阻塞消息通道
    sendResponse({ started: true })
    // 异步执行流程
    captureAndStitch().catch((e) => console.error("Screenshot pipeline failed:", e))
    return undefined as unknown as boolean
  }
})

const CAPTURE_BASE_DELAY_MS = 800 // 基础节流延时，降低每秒调用频次
const CAPTURE_MAX_RETRY = 5

async function captureAndStitch() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const activeTab = tabs[0]
  if (!activeTab || !activeTab.id) {
    console.error("No active tab found or tab ID is missing.")
    return
  }
  const tabId = activeTab.id

  try {
    // 在页面环境中预处理，记录样式并隐藏滚动条
    const prep = await execInPage<{ totalHeight: number; viewportHeight: number; dpr: number }>(
      tabId,
      () => {
        const w = window as any
        if (!w.__snapshotBackup) {
          const fixed: Array<{ el: HTMLElement; pos: string; top: string }> = []
          const originalScrollTop = window.scrollY
          const originalOverflow = document.body.style.overflow
          const all = Array.from(document.querySelectorAll("*")) as HTMLElement[]
          all.forEach((el) => {
            const cs = getComputedStyle(el)
            if (cs.position === "fixed" || cs.position === "sticky") {
              fixed.push({ el, pos: el.style.position, top: el.style.top })
              el.style.position = "absolute"
              el.style.top = `${el.getBoundingClientRect().top + window.scrollY}px`
            }
          })
          document.body.style.overflow = "hidden"
          w.__snapshotBackup = { fixed, originalScrollTop, originalOverflow }
        }
        return {
          totalHeight: document.documentElement.scrollHeight,
          viewportHeight: window.innerHeight,
          dpr: window.devicePixelRatio || 1
        }
      }
    )

    const { totalHeight, viewportHeight } = prep
    const steps = Math.max(1, Math.ceil(totalHeight / viewportHeight))

    const images: string[] = []
    for (let i = 0; i < steps; i++) {
      const top = Math.min(i * viewportHeight, Math.max(0, totalHeight - viewportHeight))
      await execInPage(tabId, (y: number) => {
        window.scrollTo(0, y)
        return { y: window.scrollY }
      }, [top])
      // 等待渲染稳定 + 节流，避免超过每秒调用限制
      await delay(CAPTURE_BASE_DELAY_MS)
      const dataUrl = await captureVisibleWithRetry()
      images.push(dataUrl)
    }

    const finalUrl = await stitchImages(images, totalHeight, viewportHeight)

    await chrome.downloads.download({
      url: finalUrl,
      filename: "screenshot.png",
      saveAs: true
    })
  } catch (error) {
    console.error("Screenshot failed:", error)
  } finally {
    // 恢复页面状态
    try {
      await execInPage(tabId, () => {
        const w = window as any
        const b = w.__snapshotBackup
        if (b) {
          b.fixed.forEach((item: { el: HTMLElement; pos: string; top: string }) => {
            item.el.style.position = item.pos
            item.el.style.top = item.top
          })
          document.body.style.overflow = b.originalOverflow
          window.scrollTo(0, b.originalScrollTop)
        }
        w.__snapshotBackup = undefined
        return { restored: true }
      })
    } catch (e) {
      console.error("Failed to restore page:", e)
    }
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

async function captureVisibleWithRetry(attempt = 0): Promise<string> {
  try {
    return await chrome.tabs.captureVisibleTab(undefined, { format: "png" })
  } catch (e: any) {
    const msg = (e?.message || String(e)).toLowerCase()
    if (msg.includes("max_capture_visible_tab_calls_per_second") && attempt < CAPTURE_MAX_RETRY) {
      const wait = CAPTURE_BASE_DELAY_MS * Math.pow(2, attempt)
      await delay(wait)
      return captureVisibleWithRetry(attempt + 1)
    }
    throw e
  }
}

async function execInPage<T = any>(
  tabId: number,
  func: (...args: any[]) => T | Promise<T>,
  args: any[] = []
): Promise<T> {
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: func as (...args: any[]) => any,
    args
  })
  return res.result as T
}

async function dataUrlToBitmap(dataUrl: string): Promise<ImageBitmap> {
  const resp = await fetch(dataUrl)
  const blob = await resp.blob()
  return await createImageBitmap(blob)
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer()
  // 将 ArrayBuffer 转 base64
  let binary = ""
  const bytes = new Uint8Array(buffer)
  const len = bytes.length
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i])
  const base64 = btoa(binary)
  return `data:image/png;base64,${base64}`
}

async function stitchImages(images: string[], totalHeight: number, viewportHeight: number): Promise<string> {
  if (!images.length) throw new Error("No images to stitch.")

  const first = await dataUrlToBitmap(images[0])
  const scale = first.height / viewportHeight
  const width = first.width
  const canvas = new OffscreenCanvas(width, Math.round(totalHeight * scale))
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Could not get 2d context from OffscreenCanvas.")

  let y = 0
  for (const url of images) {
    const bmp = await dataUrlToBitmap(url)
    const remaining = canvas.height - y
    if (remaining <= 0) break
    const h = Math.min(bmp.height, remaining)
    ctx.drawImage(bmp, 0, 0, bmp.width, h, 0, y, bmp.width, h)
    y += h
  }

  const blob = await canvas.convertToBlob({ type: "image/png" })
  // 返回 data URL，兼容 MV3 Service Worker 下载
  return await blobToDataUrl(blob)
}