# Firefly · dsh-firefly

[English](README.md) | 中文

DeepSeek Harness 桌面端的 **Windows 任务提醒 + 任务栏进度 + 输入框历史**，合并成一个插件安装，两项功能各自可开关。

![任务完成通知](assets/toast-preview.png)

Firefly 是一个 DSH 插件包，把两件事装在一起，并且每一项都能单独关掉，不必停用整个插件：

1. **任务提醒** —— 任务结束或需要你处理时弹出 Windows 系统通知；任务运行期间在任务栏显示进度。
2. **输入历史** —— 在输入框内用 `↑` / `↓` 浏览本会话里你已经发送过的消息。

它取代了之前的两个插件 `attention-notify` 和 `dsh-desktop-extras`：只安装一次，两项功能在同一个插件行里，从
**设置 → 通用** 里开关。

## 功能

| 时机 | 效果 |
| --- | --- |
| 任意 agent 开始运行 | 任务栏按钮显示 indeterminate 进度动画 |
| 最后一个 agent 静下来 | 清除进度，约 0.6 秒后弹出「任务已完成」 |
| 工具调用等待批准（`approval/request`） | 弹出「需要你的确认」，带工具名 |
| agent 向你提问（`user-questions/request`） | 弹出「需要你的回答」，带问题标题 |
| 输入框为空时在首行按 `↑` | 回填你在本会话最近发送的一条消息 |
| 继续按 `↑` / `↓` | 继续往前 / 往后翻；越过最新一条会恢复你原来的草稿 |

通知只在窗口**最小化、隐藏或失焦**时弹出——你正看着应用时它不会打扰你。点击通知会恢复并前置窗口（尽力而为：
是否允许抢前台由 Windows 决定）。

输入历史只在编辑器**首行**接管 `↑`、**末行**接管 `↓`，所以在多行草稿中间移动光标不受影响。输入框里有可见弹层
（斜杠菜单、`@` 选择器等）、正在输入法组合、或按住 Ctrl/Alt/Meta/Shift 时都不接管。

## 环境要求

- **桌面端**（Electron）Windows 10/11：通知、任务栏进度、窗口恢复。
- 输入历史各平台可用，普通浏览器窗口里也能用。
- 需要受管理的 DSH profile —— 桌面端自带，或用 `dsh --profile` 启动。

## 安装

桌面端：**Plugins** → **Add plugin** → 填入本目录的绝对路径（或仓库地址），安装即可。

命令行：

```powershell
dsh plugin --profile desktop add "C:\path\to\dsh-firefly"
# 或者直接从 GitHub 安装
dsh plugin --profile desktop add https://github.com/<you>/dsh-firefly
```

让 agent 用插件管理工具安装：

```text
plugin_manager install_bundle C:\path\to\dsh-firefly
```

安装会把本包链接进 profile、把 `dsh-firefly` 加入 `dsh.profile.bundles`，并插入 `firefly` 插件行。卸载：

```powershell
dsh plugin --profile desktop remove dsh-firefly
```

## 开启 / 关闭某一项功能

打开 **设置 → 通用**，Firefly 会在那里加两行：

| 行 | 关掉什么 |
| --- | --- |
| 任务提醒 | 系统通知、点击回到应用、任务栏进度 |
| 输入历史 | 输入框里的 `↑`/`↓` 历史 |

开关立刻在所有打开的窗口生效，并且跨重启保留。状态存在
`<DSH_HOME>/firefly/settings.json`（通常是 `%USERPROFILE%\.dsh\firefly\settings.json`）：

```json
{
  "alerts": true,
  "history": true
}
```

两项都关掉，等价于插件装了就安静待着。想彻底从应用里拿掉，就在 **Plugins** 页面把插件**关掉**，或卸载。

如果还有别的通知插件或输入历史插件在工作（例如更早的 `input-history-arrows`），请关掉其中一个，不要让两者抢同
一个按键。

## 配置（可选）

profile 的 `cordis.patch.yml` 里可以给这一行写入默认值：

```yaml
- id: firefly
  name: 'dsh-firefly'
  config:
    alerts: true
    history: true
    notifyOnDone: true
    notifyOnApproval: true
    notifyOnQuestion: true
    taskbarProgress: true
    doneDelayMs: 600
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `alerts` | `true` | 通知、任务栏进度、窗口恢复的总开关 |
| `history` | `true` | 输入历史总开关 |
| `notifyOnDone` | `true` | 全部 agent 空闲时提示 |
| `notifyOnApproval` | `true` | 有工具调用等待批准时提示 |
| `notifyOnQuestion` | `true` | 有提问等待回答时提示 |
| `taskbarProgress` | `true` | 运行期间显示任务栏 indeterminate 进度 |
| `doneDelayMs` | `600` | 判定「全部完成」前等待的毫秒数，给紧接着的新一轮留缓冲 |

设置里的**任务提醒**和**输入历史**两个开关拥有 `alerts` 与 `history`；一旦用过开关，保存的文件就优先于行配置。其余
键仍由 patch 决定。

## 原理

```
Host 半 (index.js)                            Client 半 (client.js)
  agent/status ─────────┐                       ┌─ SSE /firefly/events ─→ 失焦时弹通知
  approval/request ─────┼─ /firefly/events      │
  user-questions/request┘                       ├─ 设置 → 通用 两行 ─→ POST /api/firefly.settings
  taskbar ─→ helper/taskbar.ps1 (ITaskbarList3) │
  开关 ─→ <DSH_HOME>/firefly/settings.json      └─ conversation.input.left ─→ ↑/↓ 历史
```

- **Host 半**跑在 DSH 的普通 Node 进程里，没有 `BrowserWindow`，所以任务栏按钮是按 Electron 主进程（Host 的父进程）
  的窗口句柄来定位的。`helper/taskbar.ps1` 每次状态切换启动一次（约 0.6–1.5 秒），调用
  `ITaskbarList3::SetProgressState` 或恢复窗口，然后退出，不常驻。
- 事件流是顶层的 `webServer` 路由（`/firefly/events`），**不是** `/api` Fetch 路由。共享的 `/api` 通道在桌面端更新
  安装前会 Drain 所有在途响应；挂在 `/api` 上的无限流会让 Drain 一直等到 10 秒期限，导致每次更新都失败。和 DSH 自己
  的 `/plugins/events` 一样，顶层路由不进这个准入集合，代价是要自己用 loopback 检查代替 `/api` 的 Cookie 鉴权。
- `approval/request` 与 `user-questions/request` 是 waterfall 事件：谁先返回谁认领，后面的监听器不再执行。控制器 UI
  注册得比任何 profile 插件都早，所以 Firefly 的监听器用 `prepend` 排在链首，观察后立即 `next()` 交给 UI。
- **Client 半**用 `fetch` 流式读取该路由（外壳提供 `fetch` 时走外壳），只有 `fetch` 不可用时才退化为 `EventSource`；
  25 秒心跳，70 秒无数据自动重连。它渲染设置里的两行，并按 Host 报告的开关放行两项功能——以 Host 为唯一真相，开关和
  实际行为不会各说各话。

## 调试

页面 Console 里：

```js
window.__firefly
// {
//   version,
//   features: { alerts, history },
//   alerts: { received, lastKind, errors },
//   history: { mounted, props, history, phase, lastKey, lastResult, errors },
//   settings: { loaded, saving, lastSavedAt, errors }
// }
```

- `alerts.received` 不增长：SSE 没连上，或 Host 没广播。
- `history.mounted: false`：输入框槽位条目没渲染（插件启用了吗？当前在会话里吗？）。
- `history.lastResult` 直接说明按键为何被跳过 —— `skip:feature-off`、`skip:popup`、`skip:not-first-line`……
- `settings.errors` 收集读写失败。

## 限制

- 通知、任务栏进度、窗口恢复**仅 Windows**；输入历史与平台无关。
- 任务栏进度只作用于 Electron 桌面窗口；用 `dsh` CLI 启动时找不到窗口，helper 会静默退出。
- Windows 的「勿扰」或应用通知开关会吞掉 toast，任务栏进度不受影响。
- 若 Windows 不允许抢前台，点击通知只会闪烁任务栏按钮。

## 许可

[MIT](LICENSE)
