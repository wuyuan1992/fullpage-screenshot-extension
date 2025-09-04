# 浏览器插件截图方案

## 核心问题
用户提出的原始方案通过滚动和 `chrome.tabs.captureVisibleTab` API 结合进行截图，并使用离屏 Canvas 合成。该方案的**核心缺陷**在于无法正确处理 `position: fixed` 和 `position: sticky` 的元素，导致这些元素在每张截图中重复出现，最终合成的图片存在严重瑕疵。

## 解决方案
为了解决上述问题，我们需要一个更健壮的方案，在截图前对页面进行预处理，并在截图后恢复页面状态。

### 方案流程
1.  **触发截图**：用户通过 `popup.tsx` 中的按钮点击，向 `background` 脚本发送一个消息，请求开始截图。
2.  **预处理页面（Content Script）**：
    *   `background` 脚本接收到消息后，向当前活动标签页的 `content` 脚本发送消息，要求其准备截图。
    *   `content` 脚本遍历整个 DOM，找出所有 `position: fixed` 和 `position: sticky` 的元素。
    *   将这些元素的 `position` 样式临时修改为 `absolute`，使其跟随页面滚动，并记录下原始样式以便后续恢复。
    *   隐藏滚动条，避免其出现在截图中 (`document.body.style.overflow = 'hidden'`)。
    *   获取页面总高度和视口高度，用于计算需要滚动的次数。
3.  **分段截图（Background Script & Content Script）**：
    *   `background` 脚本通过循环控制截图流程。
    *   在每次截图中，`background` 脚本向 `content` 脚本发送滚动指令。
    *   `content` 脚本接收指令并执行 `window.scrollTo()`。
    *   滚动完成后，`content` 脚本通知 `background` 脚本可以进行截图。
    *   `background` 脚本调用 `chrome.tabs.captureVisibleTab()` 获取当前视口的截图，并将截图的 `dataURI` 存入一个数组。
    *   重复此过程，直到滚动到页面底部。
4.  **合成图片（Background Script）**：
    *   所有分段截图完成后，`background` 脚本使用 `OffscreenCanvas` API 创建一个离屏画布。
    *   将所有分段截图按顺序绘制到画布上。
    *   从画布中导出完整的图片，格式为 `image/png`。
5.  **恢复页面（Content Script）**：
    *   `background` 脚本通知 `content` 脚本截图已完成。
    *   `content` 脚本将之前修改过的元素的样式恢复原状，并恢复滚动条。
6.  **提供下载**：
    *   `background` 脚本将最终生成的图片 `dataURI` 转换为 `Blob`，并使用 `chrome.downloads.download()` API 将其作为文件下载到用户本地。

### 技术栈与结构
-   **Plasmo**: 用于快速搭建浏览器插件项目。
-   **`popup.tsx`**: 提供用户交互界面（例如一个“开始截图”按钮）。
-   **`content.ts`**: 负责与页面 DOM 交互，包括修改样式、滚动页面。
-   **`background.ts`**: 作为总控制器，协调 `popup` 和 `content` 之间的通信，执行 `chrome.*` API 调用，并处理图片合成。
-   **`chrome.runtime.sendMessage` / `onMessage`**: 用于 `popup`, `content`, `background` 之间的通信。
-   **`chrome.tabs.captureVisibleTab`**: 用于捕获浏览器视口。
-   **`OffscreenCanvas`**: 用于在 `background` 线程中高效地合成图片，避免阻塞 UI。
-   **`chrome.downloads.download`**: 用于将最终的图片提供给用户下载。

---

## 技术方案（最终版）
为彻底规避“Receiving end does not exist”类问题，最终方案改为：由 `background` 直接通过 `chrome.scripting.executeScript` 向当前页面注入并执行小型函数，完成“预处理/滚动/恢复”等 DOM 操作，无需依赖常驻 `content script` 的消息通信。

- 触发：`popup.tsx` 仍向 `background` 发送 `captureScreenshot`。
- 预处理：`background` 注入 `preparePage`，在页面环境中：
  - 记录滚动位置与 `body.style.overflow`。
  - 将 `position: fixed/sticky` 元素改为 `absolute` 并记录原样式；隐藏滚动条。
  - 返回 `totalHeight` 与 `viewportHeight`。
- 滚动：`background` 在每次截图前注入 `scrollTo(top)`，等待渲染稳定后再 `captureVisibleTab`。
- 合成：`background` 用 `OffscreenCanvas` 拼接；同时以 `scale = firstImage.height / viewportHeight` 处理 DPR 缩放，画布高度为 `totalHeight * scale`，避免错位。
- 恢复：全部完成后注入 `restorePage`，按记录恢复样式与滚动位置。
- 权限：`activeTab`、`downloads`、`tabs`、`scripting`；`host_permissions` 为 `http/https` 全量。

该方案不依赖内容脚本是否成功注入，极大提升稳定性。

---

## 错误教训
- “Receiving end does not exist”的常见根因：
  - 页面未匹配到内容脚本 `matches` 或注入时机不对（如 `document_start`/`idle` 竞态），导致 `tabs.sendMessage` 没有接收端。
  - 目标页面为受限域（如 `chrome://`、Chrome Web Store、新标签页等），内容脚本不会注入。
  - 框架差异（如多 frame/IFrame），消息发往顶层 frame，但接收端在子 frame。
  - 后台 `onMessage` 异步处理不当（未及时 `sendResponse` 或错误使用 `return true`）造成通道异常。
- 规避策略：
  - 改用 `chrome.scripting.executeScript` 由后台直接在页面环境执行必要 DOM 操作，减少消息耦合点。
  - 若必须使用消息：确保内容脚本 `matches/all_frames/run_at` 配置正确，并在发送前先通过 `chrome.scripting.executeScript` 探测接收端或注入“桥”。
  - 对 DPR 做等比例处理，避免拼接错位。
- 验证清单：
  - 在常见站点（含长页、固定头部、复杂布局）验证；
  - 排除受限域；
  - 构建后实际安装测试，确保权限与注入无误。