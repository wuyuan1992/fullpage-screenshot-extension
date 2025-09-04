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
    // 在页面环境中预处理，记录样式并隐藏滚动条 + 包裹器以“虚拟滚动”
    const prep = await execInPage<{ totalHeight: number; viewportHeight: number; dpr: number }>(
      tabId,
      () => {
        const w = window as any
        if (!w.__snapshotBackup) {
          const backups: Array<{ el: HTMLElement; cssText: string }> = []
          const originalScrollTop = window.scrollY
          const originalOverflow = document.body.style.overflow || ""
          const all = Array.from(document.querySelectorAll("*")) as HTMLElement[]
          all.forEach((el) => {
            const cs = getComputedStyle(el)
            if (cs.position === "fixed") {
              backups.push({ el, cssText: el.style.cssText })
              el.style.setProperty("visibility", "hidden", "important")
              el.style.setProperty("pointer-events", "none", "important")
            } else if (cs.position === "sticky") {
              backups.push({ el, cssText: el.style.cssText })
              el.style.setProperty("position", "static", "important")
              el.style.setProperty("top", "auto", "important")
              el.style.setProperty("z-index", "auto", "important")
            }
          })
          // 使用样式隐藏滚动条，避免改变滚动容器行为
          let styleEl = document.querySelector('style[data-snapshot="hide-scrollbar"]') as HTMLStyleElement | null
          if (!styleEl) {
            styleEl = document.createElement("style")
            styleEl.setAttribute("data-snapshot", "hide-scrollbar")
            styleEl.textContent = `
              html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; }
              html, body { scrollbar-width: none !important; }
            `
            document.documentElement.appendChild(styleEl)
          }

          // 包裹器：将 body 子节点移入，之后通过 transform 模拟滚动，避免触发 scroll 事件
          let wrapper = document.querySelector('[data-snapshot="wrapper"]') as HTMLElement | null
          if (!wrapper) {
            wrapper = document.createElement("div")
            wrapper.setAttribute("data-snapshot", "wrapper")
            wrapper.style.cssText = "width: 100%; transform: translateY(0); will-change: transform;"
            const nodes: ChildNode[] = []
            document.body.childNodes.forEach((n) => {
              if (n !== wrapper) nodes.push(n)
            })
            nodes.forEach((n) => wrapper!.appendChild(n))
            document.body.appendChild(wrapper)
          }

          w.__snapshotBackup = { backups, originalScrollTop, originalOverflow, styleEl }
        }
        // 使用 wrapper 的实际高度作为页面内容高度，避免 scrollHeight 与虚拟滚动不一致导致画布过高
        const wrapperEl = document.querySelector('[data-snapshot="wrapper"]') as HTMLElement | null
        const contentHeight = wrapperEl ? wrapperEl.getBoundingClientRect().height : document.documentElement.scrollHeight
        return {
          totalHeight: contentHeight,
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
      // 使用 transform 模拟滚动，避免触发 scroll 驱动的“absolute 动态 top”
      await execInPage(tabId, (y: number) => {
        const wrapper = document.querySelector('[data-snapshot="wrapper"]') as HTMLElement | null
        if (wrapper) {
          wrapper.style.transform = `translateY(-${y}px)`
        }
        return { y }
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
          ;(b.backups || []).forEach((item: { el: HTMLElement; cssText: string }) => {
            item.el.style.cssText = item.cssText
          })
          if (b.styleEl && b.styleEl.parentNode) {
            b.styleEl.parentNode.removeChild(b.styleEl)
          }
          // 还原 DOM 结构：将 wrapper 子节点移回 body 并移除 wrapper
          const wrapper = document.querySelector('[data-snapshot="wrapper"]') as HTMLElement | null
          if (wrapper) {
            while (wrapper.firstChild) {
              document.body.insertBefore(wrapper.firstChild, wrapper)
            }
            wrapper.remove()
          }
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
  for (let i = 0; i < images.length; i++) {
    const url = images[i]
    const bmp = await dataUrlToBitmap(url)
    const remaining = canvas.height - y
    if (remaining <= 0) break
    let srcY = 0
    let srcH = Math.min(bmp.height, remaining)
    // 最后一张只取底部可用部分，避免重复
    if (i === images.length - 1 && remaining < bmp.height) {
      srcY = bmp.height - remaining
      srcH = remaining
    }
    ctx.drawImage(bmp, 0, srcY, bmp.width, srcH, 0, y, bmp.width, srcH)
    y += srcH
  }

  const blob = await canvas.convertToBlob({ type: "image/png" })
  // 返回 data URL，兼容 MV3 Service Worker 下载
  return await blobToDataUrl(blob)
}