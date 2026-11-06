# meituan-shenquan

在 Windows 上执行美团神券活动取消重报，自动核对门店和结果。默认中台、活动 ID 和每日库存保存在本机。

## 快速开始

安装 Git 后，在命令提示符或现有 PowerShell 中进入准备存放项目的目录，运行以下命令。

```bat
git clone https://github.com/Pikachu-pi/meituan-shenquan.git
cd meituan-shenquan
.\scripts\install.cmd
```

安装器先检测 PowerShell 7，缺失时通过 Winget 安装，然后继续配置依赖。按提示填写两个中台的商家账号。

用桌面的 Edge、Chrome 快捷方式登录对应中台，登录后关闭窗口。按使用指南安装 Agent Skill。

## 日常调用

> 用 `$meituan-shenquan` 跑神券。

首次调用补齐中台、活动 ID 和每日库存。保存后，日常调用直接按默认值提交取消和报名，结束后返回结果。需要长期调整时，可以说「把默认库存改成 300 张」。

## 文档

- 安装环境、双浏览器配置、运行结果与故障恢复见 [使用指南](references/使用指南.md)。
- Agent 调用规则见 [SKILL.md](SKILL.md)。

## 核心测试

```powershell
node --test .\scripts\tests\core.test.cjs
```
