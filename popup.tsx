import { useState } from "react"
import "./style.css"

function IndexPopup() {
  const [isLoading, setIsLoading] = useState(false)

  const handleCapture = () => {
    setIsLoading(true)
    chrome.runtime.sendMessage({ action: "captureScreenshot" }, (response) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError)
      }
      // The loading state will be reset by the background script sending a message
      // or if an error occurs. For simplicity, we can reset it here after a delay
      // or rely on a message from the background script.
      // For now, we'll just let it be, assuming the popup will close or be updated.
      setIsLoading(false)
    })
  }

  return (
    <div className="container">
      <h2>网页长截图</h2>
      <p>点击下面的按钮以捕获整个页面。</p>
      <button onClick={handleCapture} disabled={isLoading}>
        {isLoading ? "截取中..." : "开始截图"}
      </button>
    </div>
  )
}

export default IndexPopup
