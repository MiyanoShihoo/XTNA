# 符号覆盖层

`npm run overlay -- <命令>` 把分析者推断出的名字、类型与注释保存在**证据账本之外**,
以二进制的精确摘要为键。它不改写任何东西:覆盖层是一层投影,可随时导出到 Ghidra / IDA,
也可随时重建。

## 为什么要单独一层

证据必须可验证。重命名是**推断**,不是观察,所以它属于独立存储、带独立置信度标签,
而原始反编译输出保持其完整性。

## 命令

```bash
npm run overlay -- add \
  --binary ./target.exe \
  --address 0x401000 \
  --name WinMain_candidate \
  --kind function \
  --confidence inferred \
  --comment "PE 头推断的入口候选" \
  --evidence ev_0123abcd

npm run overlay -- list --binary ./target.exe
npm run overlay -- export --binary ./target.exe --format ghidra --out apply.py
npm run overlay -- export --binary ./target.exe --format ida --out apply.idc
npm run overlay -- remove --binary ./target.exe --id sym_1a2b3c4d5e6f7788
npm run overlay -- overlays
```

`--binary` 接受路径或已算好的 SHA-256。按摘要存储意味着覆盖层不会悄悄挂到同名但不同版本
的二进制上。

## 字段

| 字段                      | 含义                                                          |
| ------------------------- | ------------------------------------------------------------- |
| `address_hex` / `address` | 精确虚拟地址,十六进制与十进制各一份                           |
| `name`                    | 建议符号名                                                    |
| `kind`                    | `function` / `data` / `struct` / `field` / `label` / `import` |
| `type`                    | 可选的类 C 类型或签名                                         |
| `comment`                 | 可选的整段注释                                                |
| `confidence`              | `observed` / `inferred` / `guessed`,从不合并                  |
| `evidence_ids`            | 支撑该推断的证据记录                                          |
| `created_at`              | 首次创建时间                                                  |

条目 ID 为 `(二进制摘要, 地址, 名称)` 的 `sym_<hash>`,重复添加是更新而不是新增。

## 导出

- **Ghidra**:Python 脚本,使用 `SourceType.USER_DEFINED`;地址无函数时自动创建
- **IDA**:`MakeName` / `MakeComm`

两者都只改名,不改字节,可重复执行。

## 渲染已存储的分析文本

`npm run overlay:render -- --binary ./target.exe --evidence bundle.json --out rendered.md`

把伪代码/反汇编文本里由地址派生的标识符(`sub_401000`、`FUN_401000`、`nullsub_*`、`loc_*`)
替换成覆盖层里的名字,输出 Markdown,并写明替换了多少处。磁盘上的证据包保持字节不变,
不回写 Evidence。

## 限制

- 覆盖层目前**不会回流**到 `xtna` 的分析输出;它是存储 + 导出
- 不做自动类型推断,`type` 由分析者填写
- 置信度只是标签,不会把猜测升级成观察

## 环境变量

| 变量               | 默认               | 作用                       |
| ------------------ | ------------------ | -------------------------- |
| `XTNA_OVERLAY_DIR` | `~/.xtna/overlays` | 每个二进制的覆盖层文件位置 |
