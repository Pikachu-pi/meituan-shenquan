# 神券活动使用说明

## 首次配置

在 Windows 本机克隆仓库。

```powershell
git clone https://github.com/Pikachu-pi/meituan-shenquan.git
cd meituan-shenquan
```

双击 `程序\安装.cmd`，然后在 Ego Lite 登录要用的中台。缺少 Ego Lite 时从 [Ego Lite 官网](https://lite.ego.app/) 安装。

首次运行前，一次确认中台、Ego Lite 资料名、商家账号、活动 ID、每日库存和是否有固定剔除表。有表时放入项目根目录的[剔除清单](剔除清单/)，只留这一张。表需有「门店ID」或「美团ID」和「不报神券」两列，列出全部报名候选门店；「不报神券」填「是」或「不报」表示剔除。双中台加「中台」列，填「小仓」或「乐心宜」。

```powershell
& .\程序\Invoke-EgoShenquanLive.ps1 -Action Check -Brand xiaocang `
  -XiaocangProfile '<资料名>' -XiaocangAccount '<商家账号>' `
  -ActivityId '<活动ID>' -Inventory <每日库存> -SaveConfig -ExclusionChoice List
```

没有剔除表时留空目录，并把 `List` 换成 `None`。乐心宜用 `-Brand lexinyi`、`-LexinyiProfile`、`-LexinyiAccount`。两个中台分别保存绑定，共用一张固定表或同一个无剔除设置。定位提示选择「一律不允许」。

## 日常操作

```powershell
& .\程序\Invoke-EgoShenquanLive.ps1 -Action Register -Brand both -Submit
& .\程序\Invoke-EgoShenquanLive.ps1 -Action Cancel -Brand both -Submit
```

按本次需要运行对应命令。取消作用于指定活动当前全部报名。单中台把 `both` 换成 `xiaocang` 或 `lexinyi`。

固定表留在「剔除清单」，每次自动使用。更新表格或改为无剔除后，重新做只读核验并保存对应的 `-ExclusionChoice`。固定表被移走、修改或出现多张时，报名会停下等核对。更换活动 ID 或每日库存时，同样用 `Check -SaveConfig` 更新日常设置。

## 记录与回执

日常设置保存在本机的 `%LOCALAPPDATA%\MeituanShenquan\ego-config.json`，运行完成后会给出该次结果目录。里面有本次活动 ID、报名库存、名单文件名与校验值、选店方式和平台回执。部分失败看「报名失败门店.json」。提交结果待核实时用原目录回读。

```powershell
& .\程序\Invoke-EgoShenquanLive.ps1 -Verify -RunDir '<原运行目录>'
```
