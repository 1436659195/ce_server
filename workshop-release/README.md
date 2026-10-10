# workshop-release —— 插件工坊集装箱(中继 /workshop/* 的服务内容)

relay 从本目录读三个文件对外服务:
  scaffold.tgz / scaffold.tgz.sha256 / index.json

## 文件从哪来(单一真源)

由 **ce-platform** 仓库的 `scripts/build-workshop-scaffold.mjs` 构建后**自动同步**到本目录
(集装箱内容 = 插件 SDK + 造件技能 + 打包脚本,真源在 ce-platform —— SDK 必须与 APP 宿主同源,
本仓库只持有「对外服务的成品」,不持有原料)。

## 上架流程

1. ce-platform 侧:`node scripts/build-workshop-scaffold.mjs`(自动 cp 进本目录)
2. 本仓库 commit + push
3. 各中继(公网 VPS / 家里主机)`git pull` 即上架 —— relay 按请求现读文件,无需重启;
   仅当代码本身更新时才需重启 relay 进程

## 验证

    curl https://<中继域名>/workshop/scaffold.tgz.sha256
应等于本目录 scaffold.tgz.sha256 的内容。
