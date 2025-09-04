import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["http://*/*", "https://*/*"],
  all_frames: true,
  run_at: "document_idle"
}

let originalStyles = new Map<HTMLElement, { position: string; top: string }>()
let originalScrollTop = 0

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.action) {
    case "preparePage":
      sendResponse(preparePageForCapture())
      break
    case "scrollPage":
      window.scrollTo(0, request.scrollTop)
      sendResponse({ status: "scrolled" })
      break
    case "restorePage":
      restorePage()
      sendResponse({ status: "restored" })
      break
  }
  return true // Keep message channel open for async response
})

function preparePageForCapture() {
  originalStyles.clear()
  originalScrollTop = window.scrollY

  const allElements = Array.from(document.querySelectorAll("*")) as HTMLElement[]

  allElements.forEach((el) => {
    const style = window.getComputedStyle(el)
    if (style.position === "fixed" || style.position === "sticky") {
      originalStyles.set(el, { position: el.style.position, top: el.style.top })
      el.style.position = "absolute"
      el.style.top = `${el.getBoundingClientRect().top + window.scrollY}px`
    }
  })

  // 隐藏滚动条，避免拼接缝隙
  document.body.style.overflow = "hidden"

  return {
    totalHeight: document.documentElement.scrollHeight,
    viewportHeight: window.innerHeight
  }
}

function restorePage() {
  originalStyles.forEach((style, el) => {
    el.style.position = style.position
    el.style.top = style.top
  })
  document.body.style.overflow = "auto"

  // 恢复到原始滚动位置
  window.scrollTo(0, originalScrollTop)

  originalStyles.clear()
}