# meituan-shenquan

在 Windows 上检查美团神券报名、导出门店明细，并按需取消后重新报名。活动 ID 和每日库存由本次指令或本机配置指定。

## 快速开始

安装 Git 后，在命令提示符或现有 PowerShell 中进入准备存放项目的目录，运行以下命令。

```bat
git clone https://github.com/Pikachu-pi/meituan-shenquan.git
cd meituan-shenquan
.\scripts\install.cmd
```

安装器先检测 PowerShell 7，缺失时通过 Winget 安装，然后继续配置依赖。按提示填写两个中台的商家账号。

分别打开桌面的 Edge、Chrome 登录快捷方式。登录对应中台后，关闭专用浏览器窗口。打开 PowerShell 7，在仓库目录中运行前置检查。

```powershell
& .\scripts\Invoke-Shenquan.ps1 -Brand lexinyi -Mode VerifyLogin
$activityId = Read-Host '活动 ID'
$inventory = Read-Host '每日库存'
& .\scripts\Invoke-Shenquan.ps1 -Brand lexinyi -ActivityId $activityId -Inventory $inventory -Phase preflight
```

小仓用 `xiaocang`，乐心宜用 `lexinyi`。日常运行默认无头。`preflight` 导出并校验 CSV，准备取消和报名表单，停在提交前。实际取消和重报使用 `execute`。

## 文档

- 安装环境、双浏览器配置、运行结果与故障恢复见 [使用指南](references/使用指南.md)。
- Agent 调用规则见 [SKILL.md](SKILL.md)。

## 核心测试

```powershell
node --test .\scripts\tests\core.test.cjs
```
