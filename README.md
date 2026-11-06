# meituan-shenquan

在 Windows 上检查美团神券报名、导出门店明细，并按需取消后重新报名。支持活动 `80763916`，报名库存为每日 400 张。

## 快速开始

1. 在 GitHub 选择 **Code → Download ZIP**，解压到固定目录。
2. 双击 [scripts/install.cmd](scripts/install.cmd)，填写两个中台的美团商家账号。
3. 分别打开桌面的 Edge、Chrome 登录快捷方式。登录对应中台后，关闭专用浏览器窗口。
4. 在 PowerShell 7 中进入解压目录，运行前置检查。

```powershell
& .\scripts\Invoke-Shenquan.ps1 -Brand lexinyi -Mode VerifyLogin
& .\scripts\Invoke-Shenquan.ps1 -Brand lexinyi -Phase preflight
```

小仓用 `xiaocang`，乐心宜用 `lexinyi`。日常运行默认无头。`preflight` 导出并校验 CSV，准备取消和报名表单，停在提交前。实际取消和重报使用 `execute`。

## 文档

- 安装环境、双浏览器配置、运行结果与故障恢复见 [使用指南](references/使用指南.md)。
- Agent 调用规则见 [SKILL.md](SKILL.md)。

## 核心测试

```powershell
node --test .\scripts\tests\core.test.cjs
```
