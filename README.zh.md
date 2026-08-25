# dsh-auto-mode

DeepSeek Harness 的 **Auto Mode** 插件:开启后所有授权提示自动放行——需要授权的操作(工作区外写入、更宽的 shell 命令、沙箱升级等)立即执行,不再弹窗询问。输入框正上方有常驻状态芯片,实时显示当前模式。

[English](README.md) | [中文](README.zh.md)

## 一键安装

一条命令即可(插件是纯 ESM,无需构建):

```sh
dsh plugin --profile web add github:Igumi-BeXst/dsh-auto-mode
```

然后:

1. **把该 bundle 移到列表最前** — 编辑 `~/.dsh/profiles/web/package.json`,把
   `"dsh-auto-mode"` 放到 `dsh.profile.bundles` 的**第一项**(`add` 命令默认追加到末尾)。
   这个顺序保证审批监听器先于 web UI 应答器注册;顺序不对时自动放行不生效。
2. 重启 `dsh web` 并**强制刷新页面**(Ctrl+Shift+R)。芯片会出现在输入框正上方,
   与输入卡片水平对齐。
3. **点击芯片**切换。开关持久化,重启不丢,且不会产生任何聊天消息。

本地安装:克隆仓库后执行 `dsh plugin --profile web add <克隆路径>`,后续两步相同。

依赖:标准 web profile(`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`)
自带的 approval / settings / webServer 服务。

## 使用方法

- **点击输入框上方的芯片**切换 Auto Mode(全局,所有会话生效)。开关存在
  `auto-mode` 设置命名空间,持久化;不产生任何聊天消息,芯片本身就是唯一反馈。
- 状态芯片每 3 秒轮询 `/api/auto-mode/state`(窗口聚焦时立即刷新),切换后几秒内更新。
- 默认配置:`dsh-auto-mode.enabled`(默认 `false`)。

## 工作原理

插件在宿主平面注册**第一个** `approval/request` 瀑布监听器。Auto Mode 开启时,
每个请求在 web UI 应答器(树中注册更晚)转发到浏览器之前,直接被认领并返回
`allowed-once`;关闭时通过 `next()` 委托,走正常审批流程。

profile 把本 bundle 放在 `dsh.profile.bundles` **第一位**,保证监听器先于 UI
应答器注册——没有这个顺序,浏览器弹窗会先认领请求。

**安全不变式**:升级到 `danger-full-access` 的沙箱请求**只在命令不是危险删除时**
自动放行。插件通过请求的 callId 在会话日志中反查出该工具调用的**真实命令文本**,
并与 Windows 事故形态匹配——递归删除(`Remove-Item -Recurse`、`rm -rf`、
`rd /s`)、通配符删除、盘符根删除、尾部反斜杠引号路径 bug(经典的"删除一个链接
却扩大到链接目标/根目录"形态)、以及针对 junction/符号链接的删除。匹配到的命令
会穿透到交互应答器,浏览器必然先询问你;其余 `danger-full-access` 升级自动放行。
模型提示词也写明了同一条规则:破坏性删除会弹窗审批,其他需要全权限的操作会被
自动批准。

## 安全提醒

Auto Mode 会放行**所有**请求,包括破坏性操作。运行时上下文会警告模型对不可逆或
高成本操作格外谨慎,并且**破坏性删除**——递归、通配符、盘符根或针对
junction/符号链接的删除——即使 Auto Mode 开启也**始终**需要你明确批准。
任何时刻点击芯片即可关闭。

## 已知限制

- **热重载会破坏自动放行**:本插件必须比 web UI 应答器先注册监听器。干净启动能
  保证这一点(bundle 排第一)。`dev_reload_package` 会把监听器重新注册到后面,
  因此热重载本插件后必须重启 web 服务,自动放行才能恢复。
- **模式句子会被 router 系插件抑制**:`auto-mode:state` 运行时上下文条目会被
  在 `system-prompt/assemble` 上清空 `contexts` 的插件抹掉(dsh-mode-boost 和
  router-standard 预设都是这么设计的)。输入框上方的状态芯片不受影响、始终显示
  当前模式;如果希望模型也能看到模式句子,请避免与这些插件同时挂载。

## 许可证

MIT © Igumi-BeXst
